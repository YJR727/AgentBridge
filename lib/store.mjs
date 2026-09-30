// 状态存储层。
//
// 设计要点（对应需求 7 的"去重"和技术路线里的"状态放在 data/ 目录、原子写、事件保留 300 条"）：
//  - 每个逻辑文件一个串行写队列：同一文件的并发 update 不会互相覆盖。
//  - 原子写：先写 <file>.tmp 再 rename，断电/崩溃也不会留下半截 JSON。
//  - events 保留上限 300，超出丢最旧的。
//  - events 同时保存请求状态和决定，单文件队列实现首个有效选择。
//  - 按具体请求稳定标识去重；同轮不同请求保留，无标识不合并。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { safeEqual } from './crypto.mjs';

const EVENTS_LIMIT = 300;

function readJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    // 文件坏了不要让整个服务起不来：备份一份再退回默认值。
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      /* 备份失败就算了，继续用默认值 */
    }
    return fallback;
  }
}

function atomicWriteJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

export class Store {
  /**
   * @param {string} dataDir data/ 目录的绝对路径
   */
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });

    this.files = {
      config: path.join(dataDir, 'config.json'),
      subscriptions: path.join(dataDir, 'subscriptions.json'),
      events: path.join(dataDir, 'events.json'),
      batch: path.join(dataDir, 'batch.json'),
    };

    // 每个文件的写队列尾巴
    this.queues = new Map();

    // 决策的长轮询等待者：eventId -> waiter[]
    this.decisionWaiters = new Map();
  }

  // -------------------------------------------------------------------------
  // 基础读写
  // -------------------------------------------------------------------------

  get config() {
    return readJsonSafe(this.files.config, null);
  }

  set config(value) {
    atomicWriteJson(this.files.config, value);
  }

  /** 串行执行一次"读-改-写"。 */
  async update(key, mutator) {
    const prev = this.queues.get(key) ?? Promise.resolve();
    const next = prev.then(async () => {
      const file = this.files[key];
      if (!file) throw new Error(`未知的存储键：${key}`);
      const current = readJsonSafe(file, key === 'events' ? [] : null);
      const result = await mutator(current);
      if (result !== undefined) atomicWriteJson(file, result);
      return result;
    });
    // 队列本身不能因为一次失败就断掉
    this.queues.set(key, next.catch(() => {}));
    return next;
  }

  read(key, fallback = null) {
    const file = this.files[key];
    if (!file) throw new Error(`未知的存储键：${key}`);
    return readJsonSafe(file, fallback);
  }

  write(key, value) {
    const file = this.files[key];
    if (!file) throw new Error(`未知的存储键：${key}`);
    atomicWriteJson(file, value);
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /**
   * 新增一条事件并返回它。
   * @param {object} event
   */
  async addEvent(event) {
    let stored = event;
    return this.update('events', (list) => {
      const arr = Array.isArray(list) ? list : [];
      const existing = event.eventKey && arr.find(e => e.eventKey === event.eventKey);
      if (existing) { stored = existing; return undefined; }
      arr.unshift(event);
      if (arr.length > EVENTS_LIMIT) arr.length = EVENTS_LIMIT;
      return arr;
    }).then(() => stored);
  }

  // 所有决定和失效都走同一文件队列，校验与消费不能被并发请求拆开。
  async resolveEvent(id, { state = 'resolved', decision = null, replyToken = null, appAuthorized = false } = {}) {
    let outcome;
    await this.update('events', list => {
      const event = (list ?? []).find(e => e.id === id);
      if (!event) { outcome = { status: 404, error: '事件不存在' }; return undefined; }
      if (state === 'resolved') {
        const hash = replyToken && crypto.createHash('sha256').update(String(replyToken)).digest('hex');
        if (!appAuthorized && (!hash || !event.replyTokenHash || !safeEqual(hash, event.replyTokenHash))) {
          outcome = { status: 401, error: '回复令牌无效' }; return undefined;
        }
        if (event.state === 'resolved' && event.decision?.choice === decision?.choice) {
          outcome = { status: 200, accepted: false, existing: event.decision }; return undefined;
        }
        if (!event.needsDecision || event.state !== 'pending') {
          outcome = { status: 409, error: '请求已处理、已失效或无需决定', state: event.state }; return undefined;
        }
        if (!Number.isFinite(event.expiresAt) || Date.now() >= event.expiresAt) {
          event.state = 'expired';
          event.replyToken = null;
          event.decision = { choice: 'timeout', at: Date.now(), auto: true };
          outcome = { status: 409, error: '请求已过期', state: event.state }; return list;
        }
      } else if (event.state !== 'pending') {
        outcome = { status: 409, state: event.state, existing: event.decision }; return undefined;
      }
      event.state = state;
      event.replyToken = null;
      event.decision = decision ?? { choice: state === 'expired' ? 'timeout' : 'cancelled', at: Date.now(), auto: true };
      outcome = { status: 200, accepted: true, decision: event.decision };
      return list;
    });
    if (outcome.accepted || outcome.state === 'expired') this.wakeDecisionWaiters(id, this.getEvent(id)?.decision);
    return outcome;
  }

  async cancelPending() {
    await this.update('events', list => (list ?? []).map(event => {
      if (event.state !== 'pending' && !(event.needsDecision && !event.state && !event.decision)) return event;
      return { ...event, state: 'cancelled', replyToken: null, decision: { choice: 'cancelled', at: Date.now(), auto: true } };
    }));
    for (const id of this.decisionWaiters.keys()) this.wakeDecisionWaiters(id, this.getEvent(id)?.decision);
  }

  listEvents({ limit = 50, since = null } = {}) {
    const arr = this.read('events', []) ?? [];
    const filtered = since ? arr.filter((e) => (e.createdAt ?? 0) > since) : arr;
    // 上限与存储上限一致（300），否则手机上会看不到已经存在的事件
    return filtered.slice(0, Math.max(1, Math.min(EVENTS_LIMIT, limit)));
  }

  getEvent(id) {
    const arr = this.read('events', []) ?? [];
    return arr.find((e) => e.id === id) ?? null;
  }

  async patchEvent(id, patch) {
    return this.update('events', (list) => {
      const arr = Array.isArray(list) ? list : [];
      const idx = arr.findIndex((e) => e.id === id);
      if (idx >= 0) arr[idx] = { ...arr[idx], ...patch };
      return arr;
    });
  }

  // -------------------------------------------------------------------------
  // 订阅
  // -------------------------------------------------------------------------

  listSubscriptions() {
    const state = this.read('subscriptions', { items: [] }) ?? { items: [] };
    return Array.isArray(state.items) ? state.items : [];
  }

  async upsertSubscription(sub) {
    return this.update('subscriptions', (state) => {
      const obj = state && typeof state === 'object' ? state : { items: [] };
      if (!Array.isArray(obj.items)) obj.items = [];
      const idx = obj.items.findIndex((s) => s.endpoint === sub.endpoint);
      if (idx >= 0) obj.items[idx] = { ...obj.items[idx], ...sub };
      else obj.items.push(sub);
      return obj;
    });
  }

  async removeSubscription(endpoint) {
    return this.update('subscriptions', (state) => {
      const obj = state && typeof state === 'object' ? state : { items: [] };
      if (!Array.isArray(obj.items)) obj.items = [];
      obj.items = obj.items.filter((s) => s.endpoint !== endpoint);
      return obj;
    });
  }

  // -------------------------------------------------------------------------
  // 决策与等待
  // -------------------------------------------------------------------------

  getDecision(eventId) {
    return this.getEvent(eventId)?.decision ?? null;
  }

  /**
   * 记录一个决策。若该事件已有决策，返回 { accepted: false, existing }。
   */
  async putDecision(eventId, decision) {
    return this.resolveEvent(eventId, { decision, appAuthorized: true });
  }

  // -------------------------------------------------------------------------
  // 长轮询
  // -------------------------------------------------------------------------

  /**
   * 等一个事件被决策。已经决策过就立刻返回。
   * @returns {Promise<{status:'decided'|'timeout', decision?:object}>}
   */
  waitForDecision(eventId, timeoutMs) {
    const existing = this.getDecision(eventId);
    if (existing) return Promise.resolve({ status: 'decided', decision: existing });

    return new Promise((resolve) => {
      const waiters = this.decisionWaiters.get(eventId) ?? [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const list = this.decisionWaiters.get(eventId) ?? [];
        this.decisionWaiters.set(eventId, list.filter((w) => w !== waiter));
        resolve({ status: 'timeout' });
      }, Math.max(1, timeoutMs));
      // 不要让这个定时器拖住进程退出
      if (typeof timer.unref === 'function') timer.unref();

      const waiter = (decision) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ status: 'decided', decision });
      };
      waiters.push(waiter);
      this.decisionWaiters.set(eventId, waiters);
    });
  }

  wakeDecisionWaiters(eventId, decision) {
    const waiters = this.decisionWaiters.get(eventId);
    if (!waiters || waiters.length === 0) return;
    this.decisionWaiters.delete(eventId);
    for (const w of waiters) {
      try {
        w(decision);
      } catch {
        /* 单个等待者出错不影响其他 */
      }
    }
  }

  // -------------------------------------------------------------------------
  // 汇总攒批
  // -------------------------------------------------------------------------

  async queueBatch(item) {
    return this.update('batch', (state) => {
      const obj = state && typeof state === 'object' ? state : { items: [] };
      if (!Array.isArray(obj.items)) obj.items = [];
      obj.items.push(item);
      return obj;
    });
  }

  async drainBatch() {
    let items = [];
    await this.update('batch', (state) => {
      const obj = state && typeof state === 'object' ? state : { items: [] };
      items = Array.isArray(obj.items) ? obj.items : [];
      return { items: [] };
    });
    return items;
  }

  // -------------------------------------------------------------------------
  // 清理
  // -------------------------------------------------------------------------

  async cleanup({ eventsOlderThanMs = 30 * 24 * 3600 * 1000 } = {}) {
    const cutoff = Date.now() - eventsOlderThanMs;
    await this.update('events', (list) => {
      const arr = Array.isArray(list) ? list : [];
      return arr.filter((e) => (e.createdAt ?? 0) >= cutoff).slice(0, EVENTS_LIMIT);
    });
  }
}

export { EVENTS_LIMIT };
