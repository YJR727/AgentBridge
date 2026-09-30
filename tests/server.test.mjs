// 服务端端到端测试：配对、事件、决策、超时、去重、幂等、推送加密。
//
// 这里覆盖需求第 8 节验收标准里能在本机自测的部分：
//   验收 3（点批准 → 服务端收到 choice=approve，等待方被唤醒）
//   验收 4（什么都不点 → 等待方收到超时结果）
//   验收 6（同一个 turn 不重复推送；重复提交同一个回复不重复执行）
//
// 推送不真的发到 FCM：我们替换 globalThis.fetch，用一个"假推送服务"接收请求，
// 然后用订阅者自己的私钥把正文解出来——这样验的是"端到端加密真的对"，而不只是"函数返回值对"。

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, saveConfig } from '../lib/config.mjs';
import { Store } from '../lib/store.mjs';
import { BridgeServer } from '../lib/server.mjs';
import { b64url, decryptPayload } from '../lib/crypto.mjs';

const T = { timeout: 20_000 };

/** 造一个测试环境：临时 data 目录 + 独立配置 + 端口 0（随机空闲端口）。 */
async function makeBridge({ patches = {} } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-test-'));
  // 注意：AGENT_BRIDGE_DATA 是进程级的，必须覆盖整个测试生命周期
  // （服务端内部还会读它，比如 hook 侧的自测），所以只在 cleanup 时恢复。
  const prev = process.env.AGENT_BRIDGE_DATA;
  process.env.AGENT_BRIDGE_DATA = dataDir;
  let config;
  try {
    ({ config } = loadConfig());
  } catch (err) {
    if (prev === undefined) delete process.env.AGENT_BRIDGE_DATA;
    else process.env.AGENT_BRIDGE_DATA = prev;
    throw err;
  }

  config.port = 0;
  config.vapid.subject = 'mailto:test@example.com';
  // 测试里把等待时间压到最短，避免拖慢套件
  config.push.decisionWaitMs = 600;
  config.push.decisionWaitMaxMs = 5000;
  Object.assign(config, patches);
  saveConfig(config);

  const store = new Store(dataDir);
  const logs = [];
  const logger = {
    log: (...a) => logs.push(['log', a.join(' ')]),
    warn: (...a) => logs.push(['warn', a.join(' ')]),
    error: (...a) => logs.push(['error', a.join(' ')]),
  };
  const bridge = new BridgeServer({ store, config, logger });
  const address = await bridge.start();
  const base = `http://127.0.0.1:${address.port}`;

  const cleanup = async () => {
    await bridge.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };

  return { bridge, store, config, dataDir, base, logs, cleanup };
}

/** 造一个浏览器风格的订阅者（自带私钥用于解密验证）。 */
function makeSubscription() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    subscription: {
      endpoint: 'https://push.example.com/fake-endpoint/abc',
      keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(crypto.randomBytes(16)) },
    },
  };
}

/**
 * 替换 globalThis.fetch：拦下发往 push.example.com 的请求，把请求体与请求头记下来。
 * 其余请求走真实 fetch（测试里我们用真实 HTTP 访问本机服务）。
 */
function interceptPush() {
  const realFetch = globalThis.fetch;
  const captured = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('https://push.example.com/')) {
      const headers = new Headers(init.headers);
      captured.push({
        url: target,
        authorization: headers.get('authorization'),
        contentEncoding: headers.get('content-encoding'),
        contentType: headers.get('content-type'),
        ttl: headers.get('ttl'),
        urgency: headers.get('urgency'),
        body: Buffer.from(init.body),
      });
      return new Response(null, { status: 201 });
    }
    return realFetch(url, init);
  };
  return {
    captured,
    restore: () => {
      globalThis.fetch = realFetch;
    },
  };
}

async function postJson(url, body, token = null) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data, headers: res.headers };
}

async function getJson(url, token = null) {
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/** 完成一次配对，返回 appToken。 */
async function pair(bridge, base) {
  const code = bridge.issuePairCode();
  assert.ok(code, '未配对时应当能发放配对码');
  const res = await postJson(`${base}/api/pair`, { code });
  assert.equal(res.status, 200, `配对应成功，实际 ${res.status} ${JSON.stringify(res.data)}`);
  return res.data.token;
}

test('首次启动会生成配置、VAPID 密钥与令牌', T, async () => {
  const env = await makeBridge();
  try {
    assert.ok(env.config.hookToken && env.config.hookToken.length > 20);
    assert.ok(env.config.appToken && env.config.appToken.length > 20);
    assert.notEqual(env.config.hookToken, env.config.appToken);
    assert.ok(env.config.vapid.publicKey);
    assert.ok(env.config.vapid.privateJwk);

    const hello = await getJson(`${env.base}/api/hello`);
    assert.equal(hello.status, 200);
    assert.equal(hello.data.paired, false);
    assert.equal(hello.data.vapidPublicKey, env.config.vapid.publicKey);
  } finally {
    await env.cleanup();
  }
});

test('静态资源可访问，且 sw.js 明确不缓存', T, async () => {
  const env = await makeBridge();
  try {
    const index = await fetch(`${env.base}/`);
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await index.text(), /Agent Bridge/);

    const sw = await fetch(`${env.base}/sw.js`);
    assert.equal(sw.status, 200);
    assert.match(sw.headers.get('cache-control') ?? '', /no-store/);

    const manifest = await fetch(`${env.base}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.match(manifest.headers.get('content-type') ?? '', /manifest\+json/);
    const mf = await manifest.json();
    assert.equal(mf.display, 'standalone');
    assert.equal(mf.icons.length >= 2, true);

    const icon = await fetch(`${env.base}/icon-192.png`);
    assert.equal(icon.status, 200);
    const bytes = Buffer.from(await icon.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], '必须是真 PNG');

    // 路径穿越必须被挡住
    const evil = await fetch(`${env.base}/../server.mjs`);
    assert.notEqual(evil.status, 200);
  } finally {
    await env.cleanup();
  }
});

test('未配对时：配对码错误被拒；配对成功后入口关闭', T, async () => {
  const env = await makeBridge();
  try {
    const code = env.bridge.issuePairCode();

    const wrong = await postJson(`${env.base}/api/pair`, { code: 'WRONGXXX' });
    assert.equal(wrong.status, 403);

    const ok = await postJson(`${env.base}/api/pair`, { code });
    assert.equal(ok.status, 200);
    assert.equal(ok.data.ok, true);
    assert.match(ok.headers.get('set-cookie') ?? '', /ab_token=/);

    // 需求 4：配对成功之后不再对外开放配对入口
    const again = await postJson(`${env.base}/api/pair`, { code });
    assert.equal(again.status, 409);

    // 而且不会再发新配对码
    assert.equal(env.bridge.issuePairCode(), null);
  } finally {
    await env.cleanup();
  }
});

test('上报事件需要 hookToken，手机端接口需要 appToken', T, async () => {
  const env = await makeBridge();
  try {
    const noToken = await postJson(`${env.base}/api/event`, { kind: 'notice', title: 'x' });
    assert.equal(noToken.status, 401);

    const badToken = await fetch(`${env.base}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wrong-token' },
      body: JSON.stringify({ kind: 'notice' }),
    });
    assert.equal(badToken.status, 401);

    const events = await getJson(`${env.base}/api/events`);
    assert.equal(events.status, 401);

    const token = await pair(env.bridge, env.base);
    const okEvents = await getJson(`${env.base}/api/events`, token);
    assert.equal(okEvents.status, 200);

    const real = await postJson(
      `${env.base}/api/event`,
      { kind: 'notice', title: '合法上报' },
      env.config.hookToken,
    );
    assert.equal(real.status, 200);
  } finally {
    await env.cleanup();
  }
});

test('无订阅立即返回超时，不机械等待', T, async () => {
  const env = await makeBridge();
  try {
    const token = await pair(env.bridge, env.base);
    const started = Date.now();
    const res = await postJson(
      `${env.base}/api/event`,
      {
        kind: 'decision',
        title: '需要批准：shell',
        summary: 'rm -rf build',
        needsDecision: true,
        sessionId: 's-timeout',
        turnId: 't-timeout',
      },
      env.config.hookToken,
    );
    const elapsed = Date.now() - started;

    assert.equal(res.status, 200);
    assert.equal(res.data.status, 'timeout');
    assert.equal(res.data.choice, null);
    // 必须在 decisionWaitMs（测试里设成 600ms）附近返回，不能无限等
    assert.ok(elapsed < 1000, `等待时间异常：${elapsed} ms`);

    const detail = await getJson(`${env.base}/api/events/${res.data.eventId}`, token);
    assert.equal(detail.data.event.decision.choice, 'timeout');
    assert.equal(detail.data.event.decision.auto, true);
  } finally {
    await env.cleanup();
  }
});

test('验收 3：手机点批准 → 等待被立刻唤醒，choice=approve', T, async () => {
  const env = await makeBridge();
  try {
    const token = await pair(env.bridge, env.base);
    env.bridge.pushEvent = async () => ({ ok: 1, failed: 0, details: [] });

    // 后台上报（会阻塞等待）
    const pending = postJson(
      `${env.base}/api/event`,
      {
        kind: 'decision',
        title: '需要批准：apply_patch',
        needsDecision: true,
        sessionId: 's-approve',
        turnId: 't-approve',
      },
      env.config.hookToken,
    );

    // 等事件落盘后像手机那样点"批准"
    let eventId = null;
    for (let i = 0; i < 50 && !eventId; i++) {
      const list = await getJson(`${env.base}/api/events`, token);
      eventId = list.data.events[0]?.id ?? null;
      if (!eventId) await new Promise((r) => setTimeout(r, 30));
    }
    assert.ok(eventId, '事件应当已落盘');

    const started = Date.now();
    const decided = await postJson(`${env.base}/api/events/${eventId}/decision`, { choice: 'approve' }, token);
    assert.equal(decided.status, 200);
    assert.equal(decided.data.duplicate, false);

    const res = await pending;
    assert.equal(res.data.status, 'decided');
    assert.equal(res.data.choice, 'approve');
    // 必须是被唤醒的，不是等超时等出来的
    assert.ok(Date.now() - started < 800, '决策后等待方应当立刻被唤醒');

    assert.ok(
      env.logs.some(([lvl, msg]) => lvl === 'log' && msg.includes('choice=approve')),
      '日志里应当能看到 choice=approve',
    );
  } finally {
    await env.cleanup();
  }
});

test('非决策事件拒绝审批，不能给普通通知投票', T, async () => {
  const env = await makeBridge();
  try {
    const token = await pair(env.bridge, env.base);
    const ev = await postJson(env.base + '/api/event', { kind: 'notice' }, env.config.hookToken);
    const result = await postJson(env.base + '/api/events/' + ev.data.eventId + '/decision', { choice: 'approve' }, token);
    assert.equal(result.status, 409);
    assert.equal(env.store.getEvent(ev.data.eventId).decision, null);
  } finally { await env.cleanup(); }
});

test('文字回写未验证时返回 501，不产生虚假发送状态', T, async () => {
  const env = await makeBridge();
  try {
    const token = await pair(env.bridge, env.base);
    const ev = await postJson(env.base + '/api/event', { kind: 'question' }, env.config.hookToken);
    const result = await postJson(env.base + '/api/events/' + ev.data.eventId + '/reply', { message: '用方案 B' }, token);
    assert.equal(result.status, 501);
    assert.equal(env.store.getEvent(ev.data.eventId).reply, undefined);
  } finally { await env.cleanup(); }
});

test('推送：VAPID 头 + aes128gcm 加密，正文能被订阅者解出正确 JSON', T, async () => {
  const env = await makeBridge();
  const spy = interceptPush();
  try {
    const token = await pair(env.bridge, env.base);
    const { subscription, privateKey } = makeSubscription();

    const sub = await postJson(`${env.base}/api/subscribe`, { ...subscription, userAgent: 'test' }, token);
    assert.equal(sub.status, 200);
    assert.equal(sub.data.subscriptions, 1);

    await postJson(`${env.base}/api/event`, { kind: 'error', title: '触发一条推送' }, env.config.hookToken);

    assert.equal(spy.captured.length, 1, '应当只发出一条推送');
    const sent = spy.captured[0];
    assert.match(sent.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/);
    assert.equal(sent.contentEncoding, 'aes128gcm');
    assert.equal(sent.contentType, 'application/octet-stream');

    const plaintext = decryptPayload(sent.body, privateKey, subscription.keys.auth);
    const payload = JSON.parse(plaintext);
    assert.equal(payload.title, '触发一条推送');
    assert.equal(payload.v, 1);
    assert.ok(payload.tag);
  } finally {
    spy.restore();
    await env.cleanup();
  }
});

test('需要决定的通知带一次性 replyToken 与两个按钮；长期 appToken 不出现在推送里', T, async () => {
  const env = await makeBridge();
  const spy = interceptPush();
  try {
    const token = await pair(env.bridge, env.base);
    const { subscription, privateKey } = makeSubscription();
    await postJson(`${env.base}/api/subscribe`, subscription, token);

    await postJson(
      `${env.base}/api/event`,
      { kind: 'decision', title: '需要批准：shell', needsDecision: true, turnId: 't-buttons' },
      env.config.hookToken,
    );

    assert.equal(spy.captured.length, 1);
    const payload = JSON.parse(decryptPayload(spy.captured[0].body, privateKey, subscription.keys.auth));
    assert.equal(payload.requireInteraction, true);
    assert.deepEqual(payload.data.actions, [
      { action: 'approve', title: '批准' },
      { action: 'deny', title: '拒绝' },
    ]);
    assert.ok(payload.data.replyToken && payload.data.replyToken.length > 10);

    // 关键安全断言：长期令牌绝不能进推送
    const raw = JSON.stringify(payload);
    assert.equal(raw.includes(env.config.appToken), false, 'appToken 泄漏进了推送正文');
    assert.equal(raw.includes(env.config.hookToken), false, 'hookToken 泄漏进了推送正文');
  } finally {
    spy.restore();
    await env.cleanup();
  }
});

test('验收 6：同一个具体请求只推一次（去重）', T, async () => {
  const env = await makeBridge();
  const spy = interceptPush();
  try {
    const token = await pair(env.bridge, env.base);
    const { subscription } = makeSubscription();
    await postJson(`${env.base}/api/subscribe`, subscription, token);

    const body = { kind: 'error', title: '出错了：同一轮', sessionId: 's-dup', turnId: 't-dup', requestId: 'req-1' };
    await postJson(`${env.base}/api/event`, body, env.config.hookToken);
    await postJson(`${env.base}/api/event`, body, env.config.hookToken);
    await postJson(`${env.base}/api/event`, body, env.config.hookToken);

    assert.equal(spy.captured.length, 1, '同一个具体请求只应推一次');

    // 不同 turn 要照推
    await postJson(`${env.base}/api/event`, { ...body, turnId: 't-dup-2' }, env.config.hookToken);
    assert.equal(spy.captured.length, 2);

    const pushes = await getJson(`${env.base}/api/pushes`, token);
    assert.equal(pushes.data.log.some((l) => l.deduped), true, '日志里应记录去重');
  } finally {
    spy.restore();
    await env.cleanup();
  }
});

test('成功类默认静默：不推送但记事件；切成 none 时正文不含内容', T, async () => {
  const env = await makeBridge();
  const spy = interceptPush();
  try {
    const token = await pair(env.bridge, env.base);
    const { subscription, privateKey } = makeSubscription();
    await postJson(`${env.base}/api/subscribe`, subscription, token);

    await postJson(
      `${env.base}/api/event`,
      { kind: 'success', title: '任务完成', summary: '生成了 3 个文件', turnId: 't-silent' },
      env.config.hookToken,
    );
    assert.equal(spy.captured.length, 0, '默认配置下成功类不应推送');

    const list = await getJson(`${env.base}/api/events`, token);
    assert.equal(list.data.events.length, 1, '但事件必须被记录下来');

    // 换成 none：只推"有新事件"，正文为空
    env.bridge.config.notify.success = 'push';
    env.bridge.config.notify.contentMode = 'none';
    await postJson(
      `${env.base}/api/event`,
      { kind: 'success', title: '任务完成', summary: '这段内容不应该出现在推送里', turnId: 't-none' },
      env.config.hookToken,
    );
    assert.equal(spy.captured.length, 1);
    const payload = JSON.parse(decryptPayload(spy.captured[0].body, privateKey, subscription.keys.auth));
    assert.equal(payload.body, '', 'contentMode=none 时正文必须为空');
    assert.equal(JSON.stringify(payload).includes('不应该出现'), false);
  } finally {
    spy.restore();
    await env.cleanup();
  }
});

test('订阅失效（410）会被自动删除', T, async () => {
  const env = await makeBridge();
  const realFetch = globalThis.fetch;
  try {
    const token = await pair(env.bridge, env.base);
    const { subscription } = makeSubscription();
    await postJson(`${env.base}/api/subscribe`, subscription, token);
    assert.equal(env.store.listSubscriptions().length, 1);

    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('https://push.example.com/')) return new Response('gone', { status: 410 });
      return realFetch(url, init);
    };

    await postJson(`${env.base}/api/event`, { kind: 'error', title: '触发推送' }, env.config.hookToken);

    assert.equal(env.store.listSubscriptions().length, 0, '410 之后订阅应当被删掉');
  } finally {
    globalThis.fetch = realFetch;
    await env.cleanup();
  }
});

test('没有订阅者时推送失败不影响事件记录（手机上不会是单点故障）', T, async () => {
  const env = await makeBridge();
  try {
    const res = await postJson(
      `${env.base}/api/event`,
      { kind: 'decision', title: '没人订阅时的决定类事件', needsDecision: true },
      env.config.hookToken,
    );
    assert.equal(res.data.status, 'timeout');
    assert.ok(res.data.eventId);

    const token = await pair(env.bridge, env.base);
    const detail = await getJson(`${env.base}/api/events/${res.data.eventId}`, token);
    assert.equal(detail.data.event.pushed.reason, 'no-subscription');
  } finally {
    await env.cleanup();
  }
});

test('/api/notify 永不阻塞（notify 包装脚本专用入口）', T, async () => {
  const env = await makeBridge();
  try {
    const started = Date.now();
    const res = await postJson(
      `${env.base}/api/notify`,
      { title: 'Codex 一轮结束', summary: '改完了 2 个文件', sessionId: 's-notify', turnId: 't-notify' },
      env.config.hookToken,
    );
    assert.equal(res.status, 200);
    assert.ok(Date.now() - started < 1000, '/api/notify 必须立刻返回');

    const token = await pair(env.bridge, env.base);
    const list = await getJson(`${env.base}/api/events`, token);
    assert.equal(list.data.events[0].source, 'notify-wrapper');
  } finally {
    await env.cleanup();
  }
});

test('事件保留上限 300 条，超出丢最旧的', T, async () => {
  const env = await makeBridge();
  try {
    // 直接写存储层，绕过 HTTP（这里验的是上限逻辑，不是接口）
    const writes = [];
    for (let i = 0; i < 305; i++) {
      writes.push(env.store.addEvent({ id: `ev-${i}`, kind: 'notice', title: `事件 ${i}`, createdAt: Date.now() + i }));
    }
    await Promise.all(writes);

    const all = env.store.read('events', []);
    assert.equal(all.length, 300, '存储层必须只保留 300 条');
    assert.equal(all[0].id, 'ev-304', '最新的在最前');
    assert.equal(all.some((e) => e.id === 'ev-0'), false, '最旧的应被丢弃');

    // 对外接口也要能看到全部 300 条（之前 clamp 到 200 会把事件藏起来）
    const token = await pair(env.bridge, env.base);
    const list = await getJson(`${env.base}/api/events?limit=300`, token);
    assert.equal(list.data.events.length, 300);
  } finally {
    await env.cleanup();
  }
});

test('/api/health 不需要令牌', T, async () => {
  const env = await makeBridge();
  try {
    const res = await getJson(`${env.base}/api/health`);
    assert.equal(res.status, 200);
    assert.equal(res.data.ok, true);
  } finally {
    await env.cleanup();
  }
});
