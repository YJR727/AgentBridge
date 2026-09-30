// HTTP 服务：手机端 PWA 的后端 + hook/notify 的上报入口。
//
// 路由一览（全部只绑 127.0.0.1，对外 HTTPS 由 tailscale serve 负责）：
//   GET  /                        手机端页面
//   GET  /api/hello               不需要令牌：告诉前端服务状态与 VAPID 公钥
//   POST /api/pair                不需要令牌：用一次性配对码换 appToken
//   POST /api/subscribe           需要令牌：登记 Web Push 订阅
//   POST /api/unsubscribe         需要令牌：删除订阅
//   GET  /api/events              需要令牌：事件列表
//   GET  /api/events/:id          需要令牌：事件详情
//   POST /api/events/:id/decision 需要令牌：点按钮（批准/拒绝），幂等
//   POST /api/events/:id/reply    需要令牌：回一句话，幂等
//   GET  /api/events/:id/wait     需要令牌：长轮询等决策（手机端也能用它做实时刷新）
//   POST /api/event               需要 hookToken：hook / notify 上报入口
//   GET  /api/pushes              需要令牌：推送结果日志
//   GET  /api/health              不需要令牌：存活检查（只回 ok 和时间）

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';

import { ROOT, effectiveWaitMs } from './config.mjs';
import { sendProbe, sendPush } from './push.mjs';
import { b64url, randomToken, safeEqual } from './crypto.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const MAX_BODY = 512 * 1024;

function json(res, status, obj, extraHeaders = {}) {
  const body = Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(body);
}

function text(res, status, str, contentType = 'text/plain; charset=utf-8') {
  const body = Buffer.from(str, 'utf8');
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('请求体不是合法 JSON');
  }
}

/** 生成 8 位配对码（去掉容易看错的 0/O/1/I）。 */
function makePairCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) code += alphabet[bytes[i] % alphabet.length];
  return code;
}

/** 去掉 markdown 记号，让推送正文在手机上干净一点。 */
export function stripMarkdown(input) {
  return String(input ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncate(str, maxChars) {
  const s = String(str ?? '');
  if (s.length <= maxChars) return s;
  return `${s.slice(0, Math.max(0, maxChars - 1))}…`;
}

/** 等最新一条事件落盘，拿到它的 id（自测入口用）。 */
async function waitForEventId(store, timeoutMs, requestId) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = store.listEvents({ limit: 300 }).find(e => e.requestId === requestId);
    if (latest) return latest.id;
    if (Date.now() > deadline) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 40));
  }
}

const KIND_LABEL = {
  decision: '需要你决定',
  question: '需要你回答',
  success: '任务完成',
  error: '出错了',
  notice: '通知',
};

export class BridgeServer {
  /**
   * @param {object} options
   * @param {import('./store.mjs').Store} options.store
   * @param {object} options.config
   */
  constructor({ store, config, logger = console, desktop = null }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.desktop = desktop;
    this.startedAt = Date.now();
    this.pairCode = null;
    this.pairCodeIssuedAt = null;
    this.pushLog = [];
    this.batchTimer = null;
    this.server = null;
    this.nativeUntil = 0;
    this.nativeDevices = new Map();
    this.webNotified = new Set();
    this.replyWatch = new Map();
    this.desktopReminder = () => Promise.all([this.pushDesktopQuestions(),this.pushDesktopReply()]).catch(error=>this.logger.warn('[push] 桌面提醒失败：',error.message));
  }

  // -------------------------------------------------------------------------
  // 配对
  // -------------------------------------------------------------------------

  /** 已配对后，仅电脑的“添加设备”入口可临时发放新码。 */
  issuePairCode({ addDevice = false } = {}) {
    if (this.paired && !addDevice) return null;
    this.pairCode = makePairCode();
    this.pairCodeIssuedAt = Date.now();
    return this.pairCode;
  }

  get paired() {
    return Boolean(this.config.pairedAt);
  }

  async resetPairing() {
    this.webNotified.clear();
    this.desktop?.clearSelection();
    this.nativeUntil = 0;
    this.nativeDevices.clear();
    this.replyWatch.clear();
    this.config.pairedAt = null;
    this.config.appToken = randomToken(32);
    this.store.config = this.config;
    await this.store.update('subscriptions', () => ({ items: [] }));
    await this.store.cancelPending();
    this.issuePairCode();
  }

  // -------------------------------------------------------------------------
  // 认证
  // -------------------------------------------------------------------------

  #tokenFrom(req, url) {
    const auth = req.headers.authorization ?? '';
    if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const header = req.headers['x-agent-bridge-token'];
    if (header) return String(header).trim();
    const q = url.searchParams.get('token');
    if (q) return q;
    const cookie = req.headers.cookie ?? '';
    const m = /(?:^|;\s*)ab_token=([^;]+)/.exec(cookie);
    if (m) return decodeURIComponent(m[1]);
    return null;
  }

  #requireApp(req, url, res) {
    const token = this.#tokenFrom(req, url);
    if (!this.paired || !token || !this.config.appToken || !safeEqual(token, this.config.appToken)) {
      json(res, 401, { error: '未授权：请先在手机端完成配对' });
      return false;
    }
    const device=req.headers['x-agent-bridge-device'];
    if(device!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(device)){json(res,400,{error:'设备标识不合法，请更新移动端'});return false;}
    req.bridgeDevice=device?.toLowerCase()??'legacy';
    return true;
  }

  hookOwns(q,threadId=q.threadId){
    return this.store.listEvents({limit:300}).some(e=>['pending','resolved','expired','cancelled'].includes(e.state)&&e.source==='codex-hook'&&e.sessionId===threadId&&e.turnId===q.turnId&&e.requestId!=null&&String(e.requestId)===String(q.itemId??q.requestId));
  }
  globalPending(){
    if(this.desktop?.listPending)return this.desktop.listPending().filter(q=>q.kind!=='approval'||!this.hookOwns(q));
    const s=this.desktop?.getState();if(!s?.connected||!s.selectedThread)return [];
    return [...(s.questions??[]).filter(q=>q.status==='pending').map(q=>({...q,kind:'question'})),...(s.approvals??[]).filter(q=>!this.hookOwns(q,s.selectedThread.id)).map(q=>({...q,kind:'approval',approvalKind:q.kind}))].map(q=>({...q,threadId:s.selectedThread.id,threadTitle:s.selectedThread.title}));
  }
  completionAllowed(event,deviceId){
    if(event.source!=='codex-desktop-reply')return true;
    if(Array.isArray(event.audience))return event.audience.includes(deviceId);
    return !this.desktop?.bindings||this.desktop.bindings.get(deviceId)?.threadId===event.sessionId;
  }

  #requireHook(req, res) {
    const auth = req.headers.authorization ?? '';
    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : String(req.headers['x-agent-bridge-token'] ?? '');
    if (!token || !safeEqual(token, this.config.hookToken)) {
      json(res, 401, { error: '未授权：hookToken 不匹配' });
      return false;
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  /**
   * 处理一条上报事件：落盘、按需推送、需要决定时阻塞等待。
   * @returns {Promise<object>} 给 hook 的响应体
   */
  async handleEvent(payload, { waitBudgetMs = null, origin = 'external' } = {}) {
    if (!this.config.enabled) return { status: 'disabled', choice: null };
    if (payload.source === 'codex-hook' && payload.sessionId &&
        ['Interrupt', 'SessionEnd', 'Stop'].includes(payload.hookEventName)) {
      for (const active of this.store.listEvents()) {
        if (active.state !== 'pending' || active.source !== 'codex-hook' || active.sessionId !== String(payload.sessionId)) continue;
        if (payload.hookEventName !== 'SessionEnd' && (!payload.turnId || active.turnId !== String(payload.turnId))) continue;
        await this.store.resolveEvent(active.id, { state: 'cancelled' });
      }
    }
    const kind = ['decision', 'question', 'success', 'error', 'notice'].includes(payload.kind) ? payload.kind : 'notice';
    const now = Date.now();
    const budget = effectiveWaitMs(this.config, waitBudgetMs ?? payload.waitMs);
    const requestId = payload.requestId ?? payload.tool_use_id ?? payload.itemId ?? payload.eventId;
    if(kind==='decision'&&payload.source==='codex-hook'&&payload.sessionId&&payload.turnId&&requestId!=null){
      const requestKey=JSON.stringify([String(payload.sessionId),String(payload.turnId),String(requestId)]);
      if(Object.values(this.desktop?.catalog?.ledger??{}).some(r=>r.requestKey===requestKey))return {status:'timeout',choice:null,note:'原生审批已提交或待确认，请核对电脑；不开放第二次决定'};
    }
    const event = {
      id: `ev_${now.toString(36)}_${randomToken(6)}`,
      kind,
      title: String(payload.title ?? KIND_LABEL[kind]),
      body: String(payload.body ?? ''),
      summary: truncate(payload.summary ?? payload.body ?? '', Math.min(140, Math.max(1, Number(this.config.notify?.summaryMaxChars) || 140))),
      cwd: payload.cwd ? String(payload.cwd) : null,
      source: payload.source ? String(payload.source) : origin,
      sessionId: payload.sessionId ? String(payload.sessionId) : null,
      turnId: payload.turnId ? String(payload.turnId) : null,
      requestId: requestId == null ? null : String(requestId),
      eventKey: requestId == null ? null : JSON.stringify([payload.source ?? origin, payload.sessionId ?? null, payload.turnId ?? null, kind, String(requestId)]),
      ...(Array.isArray(payload.audience)?{audience:payload.audience}:{}),
      toolName: payload.toolName ? String(payload.toolName) : null,
      hookEventName: payload.hookEventName ? String(payload.hookEventName) : null,
      needsDecision: kind === 'decision' && Boolean(payload.needsDecision),
      actions: Array.isArray(payload.actions) ? payload.actions : null,
      createdAt: now,
      decision: null,
      pushed: null,
    };
    event.state = event.needsDecision ? 'pending' : 'recorded';
    event.expiresAt = event.needsDecision ? now + budget : null;
    if (event.needsDecision && !event.actions) {
      event.actions = [
        { id: 'approve', label: '批准' },
        { id: 'deny', label: '拒绝' },
      ];
    }
    // 一次性 replyToken：长期令牌绝不进 Service Worker
    event.replyToken = event.needsDecision ? randomToken(18) : null;
    event.replyTokenHash = event.replyToken ? crypto.createHash('sha256').update(event.replyToken).digest('hex') : null;
    const stored = await this.store.addEvent(event);
    if(event.needsDecision&&event.source==='codex-hook'&&event.sessionId&&this.desktop?.ensure)void this.desktop.ensure(event.sessionId).catch(()=>{});
    if (stored.id !== event.id) {
      this.#logPush(stored, { deduped: true });
      return stored.needsDecision ? this.#waitEvent(stored) : { status: 'accepted', eventId: stored.id, duplicate: true, push: stored.pushed };
    }

    const replyCompleted = kind === 'success' && event.source === 'codex-desktop-reply';
    const shouldPush = kind === 'decision' || kind === 'error' || (kind === 'success' && (replyCompleted ? this.config.notify?.replyCompleted !== false : this.config.notify?.success !== 'silent'));
    let pushResult;
    if (!shouldPush) {
      pushResult = { ok: 0, failed: 0, details: [], silenced: true };
    } else if (kind === 'success' && !replyCompleted && this.config.notify?.success === 'batch') {
      await this.store.queueBatch({ id: event.id, title: event.title, summary: event.summary, at: now });
      this.#scheduleBatchFlush();
      pushResult = { ok: 0, failed: 0, details: [], batched: true };
    } else {
      pushResult = await this.pushEvent(event);
    }

    pushResult.nativeConnected = replyCompleted && Array.isArray(event.audience) ? event.audience.some(id=>(this.nativeDevices.get(id)??0)>Date.now()) : this.nativeUntil > Date.now();
    await this.store.patchEvent(event.id, { pushed: pushResult });
    this.#logPush(event, pushResult);

    if (!event.needsDecision) {
      return { status: 'accepted', eventId: event.id, push: pushResult, decision: null };
    }

    // 需要决定：阻塞等待手机回答，有上限
    if (!this.paired || (!pushResult?.ok && !pushResult.nativeConnected)) await this.store.resolveEvent(event.id, { state: 'expired' });
    return this.#waitEvent(event);
  }

  async #waitEvent(event) {
    const remaining = event.expiresAt - Date.now();
    if (remaining > 0) await this.store.waitForDecision(event.id, remaining);
    await this.store.resolveEvent(event.id, { state: 'expired' });
    const current = this.store.getEvent(event.id);
    const decision = current?.decision;
    if (current?.state === 'resolved' && ['approve', 'deny'].includes(decision?.choice)) {
      this.logger.log(`[decision] ${event.id} 收到 choice=${decision.choice}`);
      return { status: 'decided', eventId: event.id, choice: decision.choice, note: decision.note ?? null };
    }
    return { status: current?.state === 'cancelled' ? 'cancelled' : 'timeout', eventId: event.id, choice: null };
  }

  /** Only new completed replies from the selected chat; first snapshots are history. */
  async pushDesktopReply() {
    const states=this.desktop?.getStates?.()??[this.desktop?.getState()];
    const connected=new Set(states.filter(s=>s?.connected&&s.selectedThread).map(s=>s.selectedThread.id));
    for(const id of this.replyWatch.keys())if(!connected.has(id))this.replyWatch.delete(id);
    for(const state of states){
      if(!state?.connected||!state.selectedThread)continue;
      const threadId=state.selectedThread.id,reply=state.lastReply;
      if(!this.replyWatch.has(threadId)){this.replyWatch.set(threadId,reply?.turnId??null);continue;}
      if(!reply?.turnId||reply.phase!=='final'||reply.turnId===this.replyWatch.get(threadId))continue;
      this.replyWatch.set(threadId,reply.turnId);
      if(!this.paired||!this.config.enabled||this.config.notify?.replyCompleted===false||['cancelled','error'].includes(state.status)||!reply.text?.trim())continue;
      const audience=this.desktop.bindings?[...this.desktop.bindings].filter(([,b])=>b.threadId===threadId).map(([id])=>id):undefined;
      await this.handleEvent({kind:'success',title:`${state.selectedThread.title} · 回复已完成`,summary:stripMarkdown(reply.text),body:reply.text,
        source:'codex-desktop-reply',sessionId:threadId,turnId:reply.turnId,requestId:reply.turnId,cwd:state.selectedThread.cwd,audience});
    }
  }

  /** 推送一条事件。 */
  async pushDesktopQuestions() {
    if(!this.paired||!this.config.enabled||!this.store.listSubscriptions().length)return;
    for(const q of this.globalPending()){
      const threadId=q.threadId,key=JSON.stringify([threadId,q.turnId,q.questionId]);if(this.webNotified.has(key))continue;
      this.webNotified.add(key);if(this.webNotified.size>5000)this.webNotified.delete(this.webNotified.values().next().value);
      const event={id:key,kind:'question',title:`${q.threadTitle} · 需要您处理`,summary:truncate(q.title??q.questions?.[0]?.question??'Codex 需要您处理',140),createdAt:Date.now(),needsDecision:false,codex:{threadId,questionId:q.questionId,turnId:q.turnId}};
      const result=await this.pushEvent(event);this.#logPush(event,result);
    }
  }

  /** 推送一条事件。 */
  async pushEvent(event) {
    const subs = this.store.listSubscriptions().filter(s=>this.completionAllowed(event,s.deviceId??'legacy'));
    if (subs.length === 0) {
      this.logger.log('[push] 没有网页 Web Push 订阅；APK 使用独立后台拉取通道');
      return { ok: 0, failed: 0, details: [], reason: 'no-subscription' };
    }
    const contentMode = this.config.notify?.contentMode ?? 'summary';
    const body = contentMode === 'none' ? '' : this.config.push?.markdownStrip ? stripMarkdown(event.summary) : event.summary;

    const data = event.codex ? {kind:'codex-question',threadId:event.codex.threadId,questionId:event.codex.questionId,turnId:event.codex.turnId,at:event.createdAt} : {
      eventId: event.id,
      kind: event.kind,
      at: event.createdAt,
    };
    if (event.needsDecision) {
      data.replyToken = event.replyToken;
      data.actions = (event.actions ?? []).map((a) => ({ action: a.id, title: a.label }));
    }

    const payload = {
      v: 1,
      title: contentMode === 'none' ? '有新事件' : truncate(event.needsDecision ? `${KIND_LABEL[event.kind]}：${event.title}` : event.title, 80),
      body,
      tag: `ev-${event.id}`,
      renotify: event.needsDecision,
      requireInteraction: event.needsDecision,
      createdAt: event.createdAt,
      data,
    };

    const result = await sendPush(subs, payload, { vapid: this.config.vapid, urgency: event.needsDecision || event.codex ? 'high' : 'normal', ...(event.codex||event.source==='codex-desktop-reply'?{ttl:300}:{}), timeoutMs: event.needsDecision ? Math.max(1, Math.min(10000, event.expiresAt - Date.now())) : 10000 });

    // 404/410：订阅已失效，直接删掉
    for (const d of result.details) {
      if (d.gone) {
        this.logger.log(`[push] 订阅失效（${d.status}），已删除`);
        await this.store.removeSubscription(d.endpoint);
      }
    }
    return result;
  }

  #logPush(event, result) {
    const entry = {
      at: Date.now(),
      eventId: event.id,
      kind: event.kind,
      ok: result?.ok ?? 0,
      failed: result?.failed ?? 0,
      reasons: (result?.details ?? []).map((d) => ({
        status: d.status,
        error: d.error ?? null,
        gone: Boolean(d.gone),
      })),
      deduped: Boolean(result?.deduped),
      silenced: Boolean(result?.silenced),
      batched: Boolean(result?.batched),
      nativeConnected: Boolean(result?.nativeConnected),
    };
    this.pushLog.unshift(entry);
    if (this.pushLog.length > 200) this.pushLog.length = 200;
    if (entry.ok || entry.failed) {
      this.logger.log(`[push] ${event.id} 成功 ${entry.ok} / 失败 ${entry.failed}${entry.reasons.length ? ` 原因=${JSON.stringify(entry.reasons)}` : ''}`);
    }
  }

  #scheduleBatchFlush() {
    if (this.batchTimer) return;
    const windowMs = Math.max(1000, Number(this.config.notify?.batchWindowMs) || 60_000);
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null;
      void this.flushBatch();
    }, windowMs);
    if (typeof this.batchTimer.unref === 'function') this.batchTimer.unref();
  }

  /** 把攒批的成功事件汇总成一条推送。 */
  async flushBatch() {
    const items = await this.store.drainBatch();
    if (items.length === 0) return null;
    const contentMode = this.config.notify?.contentMode ?? 'summary';
    const body =
      contentMode === 'none'
        ? ''
        : items
            .slice(0, 10)
            .map((i) => `· ${truncate(stripMarkdown(i.title), 60)}`)
            .join('\n').slice(0, 140);
    const subs = this.store.listSubscriptions();
    const payload = {
      v: 1,
      title: contentMode === 'none' ? '有新事件' : `已完成 ${items.length} 个任务`,
      body,
      tag: 'bridge-batch',
      renotify: false,
      requireInteraction: false,
      createdAt: Date.now(),
      data: { kind: 'batch', ids: items.map((i) => i.id), at: Date.now() },
    };
    const result = await sendPush(subs, payload, { vapid: this.config.vapid, urgency: 'normal' });
    this.logger.log(`[push] 汇总 ${items.length} 条：成功 ${result.ok} / 失败 ${result.failed}`);
    return result;
  }

  // -------------------------------------------------------------------------
  // 请求分发
  // -------------------------------------------------------------------------

  async handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';

    try {
      // ---- 不需要令牌 ----
      if (pathname === '/api/health') return json(res, 200, { ok: true, at: Date.now(), version: '0.4.0', addDevicePairing: true, independentChats:true });

      if (pathname === '/api/hello') {
        return json(res, 200, {
          name: 'agent-bridge',
          version: 1,
          paired: this.paired,
          pairingOpen: Boolean(this.pairCode) && Date.now() - this.pairCodeIssuedAt < 300000,
          pairedAt: this.config.pairedAt ?? null,
          vapidPublicKey: this.config.vapid.publicKey,
          subscriptions: this.store.listSubscriptions().length,
          uptimeMs: Date.now() - this.startedAt,
          defaults: {
            decisionWaitMs: this.config.push?.decisionWaitMs,
            contentMode: this.config.notify?.contentMode,
          },
        });
      }

      if (pathname === '/api/pair' && req.method === 'POST') return await this.#handlePair(req, res);

      // 电脑控制窗读取本机 hook 凭证；手机长期令牌不能发放、重置或查看配对码。
      if ((pathname === '/api/local/pairing' && req.method === 'GET') ||
          (['/api/local/pairing/reset','/api/local/pairing/add-device'].includes(pathname) && req.method === 'POST')) {
        if (!this.#requireHook(req, res)) return undefined;
        if (pathname === '/api/local/pairing/add-device') {
          if (!this.paired) return json(res,409,{error:'请先用当前配对码连接第一台设备'});
          this.issuePairCode({addDevice:true});
        } else if (req.method === 'POST') await this.resetPairing();
        const expiresAt = this.pairCode == null ? null : this.pairCodeIssuedAt + 300000;
        return json(res, 200, { paired: this.paired,
          code: expiresAt > Date.now() ? this.pairCode : null, expiresAt });
      }

      // ---- 上报入口（hookToken） ----
      if (pathname === '/api/event' && req.method === 'POST') {
        if (!this.#requireHook(req, res)) return undefined;
        const body = await readBody(req);
        const result = await this.handleEvent(body, { origin: body.source ?? 'hook' });
        return json(res, 200, result);
      }

      if (pathname === '/api/notify' && req.method === 'POST') {
        // notify 包装脚本的入口：永不阻塞、永远 200，避免拖慢 Codex 的 turn 收尾
        if (!this.#requireHook(req, res)) return undefined;
        const body = await readBody(req);
        const event = {
          kind: 'success',
          title: body.title ?? 'Codex 一轮结束',
          summary: body.summary ?? body.body ?? '一轮对话已结束',
          body: body.body ?? '',
          cwd: body.cwd ?? null,
          sessionId: body.sessionId ?? null,
          turnId: body.turnId ?? null,
          source: 'notify-wrapper',
        };
        // 不等待：这里只记账 + 按策略推送
        const stored = await this.handleEvent({ ...event, needsDecision: false });
        return json(res, 200, { status: 'accepted', eventId: stored.eventId });
      }

      // ---- 手机端 ----
      if (pathname.startsWith('/api/codex/')) {
        if (!this.#requireApp(req, url, res)) return undefined;
        if (!this.desktop) return json(res, 503, {error:'Codex 桌面连接未启用，请更新并重启电脑服务'});
        try {
          if (pathname === '/api/codex/threads' && req.method === 'GET') return json(res, 200, {threads:await this.desktop.listThreads(),connected:true});
          if (pathname === '/api/codex/state' && req.method === 'GET') {
            const state=this.desktop.getState(req.bridgeDevice);
            state.approvals=(state.approvals??[]).filter(q=>!this.hookOwns(q,state.selectedThread?.id));
            return json(res,200,{...state,pending:this.globalPending(),serverTime:Date.now()});
          }
          if(pathname==='/api/codex/summary'&&req.method==='GET')return json(res,200,this.desktop.getSummary?.()??{devices:0,threads:[],errors:[]});
          if (req.method === 'POST') {
            if(!this.config.enabled)return json(res,409,{error:'电脑手机桥已停用'});
            const body = await readBody(req);
            // Re-pairing may have revoked this HTTP request while its body arrived.
            if (!this.#requireApp(req, url, res)) return undefined;
            if (pathname === '/api/codex/select') return json(res, 200, {selectedThread:await this.desktop.selectThread(body.threadId,req.bridgeDevice)});
            if (pathname === '/api/codex/message') return json(res, 200, await this.desktop.sendMessage(body,req.bridgeDevice));
            if (pathname === '/api/codex/answer') return json(res, 200, await this.desktop.answerQuestion(body,req.bridgeDevice));
            if (pathname === '/api/codex/approval') {
              const guard=()=>{const q=(this.desktop.listPending?.()??this.globalPending()).find(q=>q.threadId===body.threadId&&q.questionId===body.questionId);if(q&&this.hookOwns(q))throw Object.assign(new Error('当前审批已由事件卡片接管或处理，请核对来源事件'),{status:409});};
              guard();return json(res,200,await this.desktop.decideApproval(body,req.bridgeDevice,guard));
            }
          }
          return json(res, 404, {error:'未知聊天操作'});
        } catch (error) { return json(res, error.status ?? 400, {error:error.message}); }
      }
      if (pathname === '/api/native/poll' && req.method === 'GET') {
        if (!this.#requireApp(req, url, res)) return undefined;
        const now = Date.now();
        this.nativeUntil = now + 20000;
        this.nativeDevices.set(req.bridgeDevice,this.nativeUntil);
        for(const [id,expiry] of this.nativeDevices)if(expiry<now)this.nativeDevices.delete(id);
        const hideContent = this.config.notify?.contentMode === 'none';
        const events = this.store.listEvents({ limit: 100 }).map(event => {
          const active = event.state === 'pending' && event.expiresAt > now && this.config.enabled;
          return {
            id: event.id, kind: event.kind, createdAt: event.createdAt,
            title: hideContent ? '有新事件' : truncate(event.title, 80),
            summary: hideContent ? '' : truncate(event.summary, 140),
            state: event.state, needsDecision: event.needsDecision,
            expiresAt: event.expiresAt, decision: event.decision?.choice ?? null,
            replyToken: active ? event.replyToken : null,
            notify: this.config.enabled && this.completionAllowed(event,req.bridgeDevice) && (active || event.kind === 'error' || (event.kind === 'success' && (event.source==='codex-desktop-reply' ? this.config.notify?.replyCompleted!==false && now-event.createdAt<300000 : this.config.notify?.success === 'push'))),
          };
        });
        const state = this.desktop?.getState(req.bridgeDevice);
        const codex = state?.connected && state.selectedThread ? {
          threadId:state.selectedThread.id,title:state.selectedThread.title,status:state.status,
          questions:state.questions.filter(q=>q.status==='pending').map(q=>({questionId:q.questionId,title:hideContent?'Codex 需要回答':truncate(q.questions[0]?.question??'Codex 需要回答',140)})),
        } : null;
        if(codex)codex.questions.push(...(state.approvals??[]).filter(q=>!this.hookOwns(q,codex.threadId)).map(q=>({questionId:q.questionId,title:hideContent?'Codex 需要审批':truncate(q.title,140)})));
        const pending=this.globalPending().map(q=>({threadId:q.threadId,threadTitle:q.threadTitle,turnId:q.turnId,questionId:q.questionId,title:hideContent?'Codex 需要您处理':truncate(q.title??q.questions?.[0]?.question??'Codex 需要您处理',140)}));
        return json(res, 200, { events, serverTime: now, enabled: this.config.enabled, codex, pending });
      }

      if (pathname === '/api/events' && req.method === 'GET') {
        if (!this.#requireApp(req, url, res)) return undefined;
        const limit = Number(url.searchParams.get('limit') ?? 50);
        const since = url.searchParams.get('since');
        return json(res, 200, {
          events: this.store.listEvents({ limit, since: since ? Number(since) : null }).map(this.#publicEvent),
          paired: this.paired,
        });
      }

      const eventMatch = /^\/api\/events\/([A-Za-z0-9_-]+)(\/decision|\/reply|\/wait)?$/.exec(pathname);
      if (eventMatch) {
        const [, eventId, sub] = eventMatch;
        if (sub === '/decision' && req.method === 'POST') return await this.#handleDecision(req, res, eventId, url);
        if (!this.#requireApp(req, url, res)) return undefined;
        if (sub === '/reply' && req.method === 'POST') return await this.#handleReply(req, res, eventId);
        if (sub === '/wait' && req.method === 'GET') return await this.#handleWait(req, res, eventId, url);
        if (!sub && req.method === 'GET') {
          const ev = this.store.getEvent(eventId);
          if (!ev) return json(res, 404, { error: '事件不存在' });
          return json(res, 200, { event: this.#publicEvent(ev) });
        }
      }

      if (pathname === '/api/subscribe' && req.method === 'POST') {
        if (!this.#requireApp(req, url, res)) return undefined;
        const body = await readBody(req);
        const sub = this.#normalizeSubscription(body);
        if (!sub) return json(res, 400, { error: '订阅格式不对：需要 endpoint 与 keys.p256dh / keys.auth' });
        await this.store.upsertSubscription({...sub,deviceId:req.bridgeDevice});
        this.logger.log(`[push] 登记订阅（当前 ${this.store.listSubscriptions().length} 个）`);
        return json(res, 200, { ok: true, subscriptions: this.store.listSubscriptions().length });
      }

      if (pathname === '/api/unsubscribe' && req.method === 'POST') {
        if (!this.#requireApp(req, url, res)) return undefined;
        const body = await readBody(req);
        if (body.endpoint) await this.store.removeSubscription(String(body.endpoint));
        return json(res, 200, { ok: true, subscriptions: this.store.listSubscriptions().length });
      }

      if (pathname === '/api/pushes' && req.method === 'GET') {
        if (!this.#requireApp(req, url, res)) return undefined;
        return json(res, 200, { log: this.pushLog.slice(0, 100) });
      }

      // ---- 自测入口（手机端"发测试事件"/"发探测推送"用） ----
      if (pathname === '/api/admin/probe' && req.method === 'POST') {
        if (!this.#requireApp(req, url, res)) return undefined;
        const subs = this.store.listSubscriptions();
        if (subs.length === 0) return json(res, 400, { error: '还没有订阅者，先在手机上开启通知' });
        const results = [];
        for (const sub of subs) {
          // eslint-disable-next-line no-await-in-loop
          results.push(await sendProbe(sub, this.config.vapid));
        }
        const result = { ok: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length };
        this.logger.log(`[probe] 探测推送：成功 ${result.ok} / 失败 ${result.failed}`);
        return json(res, 200, { ok: true, result });
      }

      if (pathname === '/api/admin/test-event' && req.method === 'POST') {
        if (!this.#requireApp(req, url, res)) return undefined;
        const body = await readBody(req);
        const kind = ['decision', 'question', 'success', 'error', 'notice'].includes(body.kind) ? body.kind : 'decision';
        const needsDecision = kind === 'decision';
        const requestId = crypto.randomUUID();
        const waitMs = effectiveWaitMs(this.config, body.waitMs);

        // 主动自测：立刻回 eventId，让手机留在列表里自己决定；
        // 手机点按钮会通过正常决策接口唤醒下面这个等待（用于验证"超时后不卡死"）。
        const promise = this.handleEvent(
          {
            kind,
            title: body.title ?? '（自测）需要你批准',
            body:
              body.body ??
              '这是一条自测事件，用来验证通知、按钮、超时三条路径。它不来自 Codex，不影响任何真实会话。',
            summary: body.summary ?? '自测事件：请点「批准」或「拒绝」，或者什么都不做等超时。',
            cwd: body.cwd ?? ROOT,
            source: 'selftest',
            requestId,
            sessionId: body.sessionId ?? 'selftest-session',
            turnId: body.turnId ?? `selftest-turn-${Date.now()}`,
            needsDecision,
            waitMs,
          },
          { origin: 'selftest' },
        );
        // 不要让它把请求挂住；结果只写日志
        promise.then(
          (r) => this.logger.log(`[selftest] 测试事件结束：${r.status}${r.choice ? ` choice=${r.choice}` : ''}`),
          (e) => this.logger.error(`[selftest] 测试事件异常：${e?.message}`),
        );

        // 等一小会儿拿到 eventId（事件已经落盘）
        const eventId = await waitForEventId(this.store, 1500, requestId);
        return json(res, 200, { ok: true, eventId, kind, needsDecision, waitMs });
      }

      // ---- 静态资源 ----
      return this.#serveStatic(req, res, pathname === '/' ? '/index.html' : pathname);
    } catch (err) {
      this.logger.error(`[http] ${req.method} ${pathname} 请求失败`);
      if (!res.headersSent) json(res, 500, { error: String(err?.message ?? err) });
      return undefined;
    }
  }

  async #handlePair(req, res) {
    const body = await readBody(req);
    const code = String(body.code ?? '').trim().toUpperCase();
    if (!code) return json(res, 400, { error: '缺少配对码' });

    if (!this.pairCode) return json(res, 409, { error: this.paired ? '配对入口已关闭，请在电脑点击“添加设备”生成新码' : '当前没有有效配对码，请在电脑点击“重新配对”' });
    if (Date.now() - this.pairCodeIssuedAt >= 300000) {
      this.pairCode = null;
      return json(res, 410, { error: '配对码已过期，请在电脑上重新生成' });
    }
    if (!safeEqual(code, this.pairCode)) {
      this.logger.warn('[pair] 配对码错误');
      return json(res, 403, { error: '配对码不正确' });
    }

    // ponytail: devices share permission; reset revokes all. Separate credentials only if individual revocation is needed.
    this.config.pairedAt ||= Date.now();
    this.store.config = this.config;
    this.pairCode = null;
    this.logger.log('[pair] 配对成功，配对入口已关闭');

    const cookie = [
      `ab_token=${encodeURIComponent(this.config.appToken)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${180 * 24 * 3600}`,
      'Secure',
    ].join('; ');

    return json(res, 200, { ok: true, token: this.config.appToken, pairedAt: this.config.pairedAt }, { 'Set-Cookie': cookie });
  }

  #normalizeSubscription(body) {
    const endpoint = body?.endpoint;
    const p256dh = body?.keys?.p256dh ?? body?.p256dh;
    const auth = body?.keys?.auth ?? body?.auth;
    if (!endpoint || !p256dh || !auth) return null;
    return {
      endpoint: String(endpoint),
      keys: { p256dh: String(p256dh).trim(), auth: String(auth).trim() },
      addedAt: Date.now(),
      userAgent: body?.userAgent ? String(body.userAgent).slice(0, 200) : null,
    };
  }

  #publicEvent = (event) => {
    const { replyToken, replyTokenHash, ...visible } = event;
    if(event.sessionId)visible.threadTitle=this.desktop?.entries?.get(event.sessionId)?.bridge.getState().selectedThread?.title??event.sessionId;
    return visible;
  };

  async #handleDecision(req, res, eventId, url) {
    const ev = this.store.getEvent(eventId);
    if (!ev) return json(res, 404, { error: '事件不存在' });
    const body = await readBody(req);
    const token = this.#tokenFrom(req, url);
    const appAuthorized = this.paired && Boolean(token) && safeEqual(token, this.config.appToken);

    let choice = String(body.choice ?? '').trim().toLowerCase();
    const allowed = (ev.actions ?? [{ id: 'approve' }, { id: 'deny' }]).map((a) => a.id);
    if (choice === 'reject') choice = 'deny';
    if (!allowed.includes(choice)) {
      return json(res, 400, { error: `choice 只能是 ${allowed.join(' / ')}` });
    }

    const decision = {
      choice,
      note: body.note ? String(body.note).slice(0, 2000) : null,
      at: Date.now(),
      via: body.via ? String(body.via).slice(0, 40) : 'app',
    };
    const outcome = await this.store.resolveEvent(eventId, { decision, appAuthorized, replyToken: body.replyToken });
    if (outcome.status !== 200) return json(res, outcome.status, { ok: false, error: outcome.error, state: outcome.state });
    if (!outcome.accepted) {
      // 需求 7：重复提交同一个回复不重复执行
      this.logger.log(`[decision] ${eventId} 重复提交被忽略（首次 choice=${outcome.existing.choice}）`);
      return json(res, 200, { ok: true, duplicate: true, decision: outcome.existing });
    }

    this.logger.log(`[decision] ${eventId} recorded choice=${choice} via=${decision.via}`);
    return json(res, 200, { ok: true, duplicate: false, decision });
  }

  async #handleReply(req, res) {
    return json(res, 501, { error: '文字回写尚未验证，当前关闭；请在电脑中回答 Codex' });
  }

  async #handleWait(req, res, eventId, url) {
    const timeout = Math.min(120_000, Math.max(1000, Number(url.searchParams.get('timeout') ?? 90_000)));
    const outcome = await this.store.waitForDecision(eventId, timeout);
    return json(res, 200, outcome);
  }

  #serveStatic(req, res, pathname) {
    const safePath = path.normalize(pathname).replace(/^([/\\])+/, '');
    const full = path.join(ROOT, 'public', safePath);
    if (!full.startsWith(path.join(ROOT, 'public'))) return text(res, 403, 'Forbidden');

    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return text(res, 404, 'Not Found');
    }
    if (!stat.isFile()) return text(res, 404, 'Not Found');

    const ext = path.extname(full).toLowerCase();
    const isSw = path.basename(full) === 'sw.js';
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': stat.size,
      // Service Worker 必须不缓存，否则手机上永远拿到旧版本
      'Cache-Control': isSw ? 'no-cache, no-store, must-revalidate' : 'no-cache',
    });
    fs.createReadStream(full).pipe(res);
    return undefined;
  }

  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  /** 启动 HTTP 服务。 */
  async start() {
    this.nativeUntil = 0;
    if (this.config.host !== '127.0.0.1') throw new Error('服务只允许绑定 127.0.0.1');
    // 没配对过就立刻发一个配对码，这样启动日志里能直接打印出来
    if (!this.config.pairedAt) {
      this.issuePairCode();
    } else {
      this.pairCode = null;
    }
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
    // 移动端长轮询 + 慢网络，超时给宽一点，但必须有上限
    this.server.requestTimeout = 150_000;
    this.server.headersTimeout = 20_000;
    this.server.keepAliveTimeout = 65_000;

    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, () => {
        this.server.off('error', reject);
        resolve();
      });
    });
    await this.store.cancelPending();
    this.desktop?.waiters?.add(this.desktopReminder);
    this.desktop?.start?.();
    return this.server.address();
  }

  async stop() {
    this.desktop?.waiters?.delete(this.desktopReminder);
    this.nativeUntil = 0;
    this.nativeDevices.clear();
    this.desktop?.stop?.();
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    await this.store.cancelPending();
    if (!this.server) return;
    await new Promise((resolve) => this.server.close(resolve));
  }
}

export { KIND_LABEL, b64url };
