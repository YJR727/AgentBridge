import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { defaultConfig } from '../lib/config.mjs';
import { generateP256KeyPair } from '../lib/crypto.mjs';
import { Store } from '../lib/store.mjs';
import { BridgeServer } from '../lib/server.mjs';

async function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-regression-'));
  const config = defaultConfig();
  const keys = generateP256KeyPair();
  Object.assign(config, { port: 0, pairedAt: Date.now(), appToken: 'phone-secret', hookToken: 'hook-secret' });
  config.vapid = { publicKey: keys.publicKeyB64, privateJwk: keys.privateJwk, subject: 'mailto:test@example.com' };
  const store = new Store(dir);
  const bridge = new BridgeServer({ store, config, logger: { log() {}, warn() {}, error() {} } });
  bridge.pushEvent = async () => ({ ok: 1, failed: 0, details: [] });
  const address = await bridge.start();
  const base = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await bridge.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  const post = async (route, body, token = config.appToken) => {
    const res = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, data: res.headers.get('content-type')?.includes('application/json') ? await res.json() : {error:await res.text()} };
  };
  return { store, bridge, config, base, post };
}
async function pending(env, payload = {}) {
  const promise = env.bridge.handleEvent({ kind: 'decision', needsDecision: true, waitMs: 1000, ...payload });
  for (let i = 0; i < 100; i++) {
    const ev = env.store.listEvents()[0];
    if (ev) return { promise, ev };
    await new Promise(r => setTimeout(r, 2));
  }
  throw new Error('事件未落盘');
}

test('电脑重新配对按钮接口：只允许 hook 凭证，生成新码并撤销旧手机与待处理请求', async t => {
  const e=await setup(t);
  const {promise,ev}=await pending(e);
  const oldToken=e.config.appToken;
  assert.equal((await fetch(e.base+'/api/local/pairing')).status,401);
  assert.equal((await e.post('/api/local/pairing/reset',{})).status,401);
  const result=await e.post('/api/local/pairing/reset',{},e.config.hookToken);
  assert.equal(result.status,200);
  assert.match(result.data.code,/^[A-HJ-NP-Z2-9]{8}$/);
  assert.ok(result.data.expiresAt>Date.now());
  assert.equal(e.store.getEvent(ev.id).state,'cancelled');
  assert.equal((await promise).status,'cancelled');
  assert.equal((await fetch(e.base+'/api/events',{headers:{Authorization:'Bearer '+oldToken}})).status,401);
  assert.equal((await e.post('/api/events/'+ev.id+'/decision',{choice:'approve',replyToken:ev.replyToken},null)).status,409);
  const current=await(await fetch(e.base+'/api/local/pairing',{headers:{Authorization:'Bearer '+e.config.hookToken}})).json();
  assert.equal(current.code,result.data.code);
  const second=await e.post('/api/local/pairing/reset',{},e.config.hookToken);
  assert.notEqual(second.data.code,result.data.code);
  assert.equal((await e.post('/api/pair',{code:result.data.code},null)).status,403);
  assert.equal((await e.post('/api/pair',{code:second.data.code},null)).status,200);
  const closed=await(await fetch(e.base+'/api/local/pairing',{headers:{Authorization:'Bearer '+e.config.hookToken}})).json();
  assert.equal(closed.paired,true);
  assert.equal(closed.code,null);
});

test('添加第二台设备保留旧凭证、订阅、当前聊天和待审批，两端共享一次决定', async t => {
  const e=await setup(t),oldToken=e.config.appToken,pairedAt=e.config.pairedAt;
  const selected={id:'existing-chat'};let cleared=0;
  e.bridge.desktop={selectedThread:selected,clearSelection(){cleared++;},getState(){return {connected:false};},waiters:new Set()};
  await e.store.upsertSubscription({endpoint:'https://push.example.test/ipad',keys:{p256dh:'existing',auth:'existing'}});
  await e.store.addEvent({id:'shared-approval',kind:'decision',state:'pending',needsDecision:true,expiresAt:Date.now()+10000,replyToken:'one-use'});
  await fetch(e.base+'/api/native/poll',{headers:{Authorization:'Bearer '+oldToken}});
  const nativeUntil=e.bridge.nativeUntil;
  assert.equal((await e.post('/api/local/pairing/add-device',{},null)).status,401);
  assert.equal((await e.post('/api/local/pairing/add-device',{},oldToken)).status,401);
  const added=await e.post('/api/local/pairing/add-device',{},e.config.hookToken);
  assert.equal(added.status,200);assert.match(added.data.code,/^[A-HJ-NP-Z2-9]{8}$/);assert.equal(added.data.paired,true);
  assert.equal((await(await fetch(e.base+'/api/hello')).json()).pairingOpen,true);
  const current=await(await fetch(e.base+'/api/local/pairing',{headers:{Authorization:'Bearer '+e.config.hookToken}})).json();
  assert.equal(current.code,added.data.code);
  const second=await e.post('/api/pair',{code:added.data.code},null);
  assert.equal(second.status,200);assert.equal(second.data.token,oldToken);
  assert.equal(e.config.pairedAt,pairedAt);assert.equal(e.bridge.nativeUntil,nativeUntil);assert.equal(cleared,0);assert.equal(e.bridge.desktop.selectedThread,selected);
  assert.equal(e.store.listSubscriptions().length,1);assert.equal(e.store.getEvent('shared-approval').state,'pending');
  const read=async token=>{const response=await fetch(e.base+'/api/events/shared-approval',{headers:{Authorization:'Bearer '+token}});assert.equal(response.status,200);return (await response.json()).event;};
  assert.equal((await read(oldToken)).state,'pending');assert.equal((await read(second.data.token)).state,'pending');
  assert.equal((await e.post('/api/events/shared-approval/decision',{choice:'approve'},oldToken)).status,200);
  assert.equal((await read(second.data.token)).state,'resolved');
  assert.equal((await e.post('/api/events/shared-approval/decision',{choice:'deny'},second.data.token)).status,409);
  assert.equal((await e.post('/api/pair',{code:added.data.code},null)).status,409);
  assert.equal((await(await fetch(e.base+'/api/hello')).json()).pairingOpen,false);
});

test('添加设备码可替换、五分钟过期，重启关闭入口而旧设备继续有效', async t => {
  const e=await setup(t),oldToken=e.config.appToken;
  const first=await e.post('/api/local/pairing/add-device',{},e.config.hookToken);
  assert.equal(first.status,200);
  const second=await e.post('/api/local/pairing/add-device',{},e.config.hookToken);
  assert.notEqual(first.data.code,second.data.code);
  assert.equal((await e.post('/api/pair',{code:first.data.code},null)).status,403);
  e.bridge.pairCodeIssuedAt=Date.now()-300001;
  assert.equal((await e.post('/api/pair',{code:second.data.code},null)).status,410);
  const third=await e.post('/api/local/pairing/add-device',{},e.config.hookToken);
  assert.equal(third.status,200);
  await e.bridge.stop();const address=await e.bridge.start();const base=`http://127.0.0.1:${address.port}`;
  assert.equal(e.bridge.pairCode,null);assert.equal(e.config.appToken,oldToken);
  assert.equal((await fetch(base+'/api/events',{headers:{Authorization:'Bearer '+oldToken}})).status,200);
  assert.equal((await fetch(base+'/api/pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:third.data.code})})).status,409);
});

test('添加设备后重新配对仍撤销两端的旧权限、订阅和未使用的添加码', async t => {
  const e=await setup(t),oldToken=e.config.appToken;
  const added=await e.post('/api/local/pairing/add-device',{},e.config.hookToken);
  assert.equal(added.status,200);
  const second=await e.post('/api/pair',{code:added.data.code},null);assert.equal(second.status,200);
  await e.store.upsertSubscription({endpoint:'https://push.example.test/ipad'});
  const unused=await e.post('/api/local/pairing/add-device',{},e.config.hookToken);
  const reset=await e.post('/api/local/pairing/reset',{},e.config.hookToken);assert.equal(reset.status,200);
  for(const token of [oldToken,second.data.token])assert.equal((await fetch(e.base+'/api/events',{headers:{Authorization:'Bearer '+token}})).status,401);
  assert.equal(e.store.listSubscriptions().length,0);
  assert.equal((await e.post('/api/pair',{code:unused.data.code},null)).status,403);
  assert.equal((await e.post('/api/local/pairing/add-device',{},e.config.hookToken)).status,409);
});

test('Interrupt 只取消对应任务轮次，撤销通知按钮令牌', async t => {
  const e = await setup(t);
  const {promise, ev} = await pending(e, {source:'codex-hook', sessionId:'session-a', turnId:'turn-a'});
  const other = {id:'other-session', source:'codex-hook', sessionId:'session-b', turnId:'turn-a', state:'pending', needsDecision:true, expiresAt:Date.now()+10000, replyToken:'other'};
  await e.store.addEvent(other);
  await e.bridge.handleEvent({source:'codex-hook', kind:'notice', hookEventName:'Interrupt', sessionId:'session-a', turnId:'turn-a'});
  assert.equal(e.store.getEvent(ev.id).state, 'cancelled');
  assert.equal(e.store.getEvent(other.id).state, 'pending');
  assert.notEqual((await promise).status, 'decided');
  assert.equal((await e.post(`/api/events/${ev.id}/decision`, {choice:'approve', replyToken:ev.replyToken}, null)).status, 409);
});

test('通知令牌无需长期手机凭证，但不能查看详情；一次回复后相反决定被拒绝', async t => {
  const e = await setup(t);
  const { promise, ev } = await pending(e);
  const route = `/api/events/${ev.id}/decision`;
  assert.equal((await e.post(route, { choice: 'approve', replyToken: 'wrong' }, null)).status, 401);
  assert.equal((await fetch(e.base + `/api/events/${ev.id}?token=${ev.replyToken}`)).status, 401);
  const first = await e.post(route, { choice: 'approve', replyToken: ev.replyToken }, null);
  assert.equal(first.status, 200);
  assert.equal((await promise).choice, 'approve');
  assert.equal(e.store.getEvent(ev.id).state, 'resolved');
  assert.equal((await e.post(route, { choice: 'deny' })).status, 409);
  const again = await e.post(route, { choice: 'approve', replyToken: ev.replyToken }, null);
  assert.equal(again.data.duplicate, true);
  assert.equal(e.store.getEvent(ev.id).replyToken, null);
});
test('过期、取消、非决策事件不能被批准；期限由服务端检查', async t => {
  const e = await setup(t);
  for (const state of ['expired', 'cancelled', 'recorded', 'pending']) {
    await e.store.addEvent({ id: state, state, needsDecision: state !== 'recorded', expiresAt: Date.now() - 1, replyToken: 'test' });
    assert.equal((await e.post(`/api/events/${state}/decision`, { choice: 'approve' })).status, 409);
  }
});
test('超时不能被迟到批准复活', async t => {
  const e = await setup(t);
  const { promise, ev } = await pending(e);
  assert.equal((await promise).status, 'timeout');
  assert.equal((await e.post(`/api/events/${ev.id}/decision`, { choice: 'approve' })).status, 409);
  assert.equal(e.store.getEvent(ev.id).state, 'expired');
});
test('相反决定并发只有一个成功', async t => {
  const e = await setup(t);
  const { promise, ev } = await pending(e);
  const replies = await Promise.all(['approve', 'deny'].map(choice => e.post(`/api/events/${ev.id}/decision`, { choice })));
  assert.deepEqual(replies.map(r => r.status).sort(), [200, 409]);
  assert.ok(['approve', 'deny'].includes((await promise).choice));
});
test('同一请求并发重投复用事件，同轮不同请求分开推送；无标识保守保留', async t => {
  const e = await setup(t);
  let pushes = 0;
  e.bridge.pushEvent = async () => { pushes++; return { ok: 1, failed: 0, details: [] }; };
  const body = { kind: 'error', source: 'test', sessionId: 's', turnId: 't', requestId: 'a' };
  const result = await Promise.all([e.bridge.handleEvent(body), e.bridge.handleEvent(body)]);
  assert.equal(result[0].eventId, result[1].eventId);
  await e.bridge.handleEvent({ ...body, requestId: 'b' });
  assert.equal(pushes, 2);
  await e.bridge.handleEvent({ ...body, requestId: null });
  await e.bridge.handleEvent({ ...body, requestId: null });
  assert.equal(pushes, 4);
});
test('同一审批重投共用有效等待，不创建第二个批准目标', async t => {
  const e = await setup(t);
  const body = { source: 'test', sessionId: 's', requestId: 'same' };
  const { promise, ev } = await pending(e, body);
  const second = e.bridge.handleEvent({ kind: 'decision', needsDecision: true, ...body });
  await e.post(`/api/events/${ev.id}/decision`, { choice: 'deny' });
  const replies = await Promise.all([promise, second]);
  assert.equal(replies[0].eventId, replies[1].eventId);
  assert.equal(replies[1].choice, 'deny');
  assert.equal(e.store.listEvents().length, 1);
});
test('重新启动使遗留 pending 请求取消，已解决事件仍可去重', async t => {
  const e = await setup(t);
  await e.store.addEvent({ id: 'old', state: 'pending', needsDecision: true, expiresAt: Date.now() + 60000, replyToken: 'old' });
  await e.bridge.stop();
  e.config.port = Number(new URL(e.base).port);
  await e.bridge.start();
  assert.equal(e.store.getEvent('old').state, 'cancelled');
  assert.equal((await e.post('/api/events/old/decision', { choice: 'approve' })).status, 409);
});
test('重新配对撤销旧手机、订阅、请求令牌；配对码五分钟过期', async t => {
  const e = await setup(t);
  const oldToken = e.config.appToken;
  await e.store.upsertSubscription({ endpoint: 'https://push.example.com/old' });
  await e.store.addEvent({ id: 'old', state: 'pending', needsDecision: true, expiresAt: Date.now() + 60000 });
  await e.bridge.resetPairing();
  assert.notEqual(e.config.appToken, oldToken);
  assert.equal(e.store.listSubscriptions().length, 0);
  assert.equal(e.store.getEvent('old').state, 'cancelled');
  assert.equal((await e.post('/api/subscribe', {}, oldToken)).status, 401);
  const code = e.bridge.issuePairCode();
  e.bridge.pairCodeIssuedAt = Date.now() - 300001;
  assert.equal((await e.post('/api/pair', { code }, null)).status, 410);
});
test('无订阅和全部推送失败立即回退，文字回写关闭', async t => {
  const e = await setup(t);
  e.bridge.pushEvent = async () => ({ ok: 0, failed: 1, details: [] });
  const start = Date.now();
  const result = await e.bridge.handleEvent({ kind: 'decision', needsDecision: true });
  assert.equal(result.status, 'timeout');
  assert.ok(Date.now() - start < 500);
  assert.equal(e.store.getEvent(result.eventId).state, 'expired');
  assert.equal((await e.post(`/api/events/${result.eventId}/reply`, { message: 'hi' })).status, 501);
});
test('服务拒绝非回环绑定', async t => {
  const e = await setup(t);
  await e.bridge.stop();
  e.config.host = '0.0.0.0';
  await assert.rejects(e.bridge.start(), /127\.0\.0\.1/);
});

for (const status of [200, 401, 403, 409, 500, 'network', 'opposite']) {
  test(`通知按钮正确处理 ${status}`, async () => {
    const handlers = {}, shown = [];
    const self = { addEventListener: (name, handler) => { handlers[name] = handler; }, registration: { showNotification: async (title, opts) => shown.push({ title, ...opts }) } };
    let sent;
    vm.runInNewContext(fs.readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8'), { self, AbortSignal, fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      if (status === 'network') throw new Error('offline');
      return { ok: status === 200 || status === 'opposite', status, json: async () => ({ ok: true, duplicate: status === 'opposite', decision: { choice: status === 'opposite' ? 'deny' : 'approve' } }) };
    } });
    let work;
    handlers.notificationclick({ action: 'approve', notification: { data: { eventId: 'ev', replyToken: 'secret' }, close() {} }, waitUntil(p) { work = p; } });
    await work;
    assert.equal(sent.replyToken, 'secret');
    assert.equal(shown[0].title, status === 200 ? '选择已记录' : '回传失败');
    assert.doesNotMatch(shown[0].body, /电脑上会继续执行/);
  });
}

test('APK 拉取仅配对手机可用，在线期间无 Web Push 订阅也能等待并回传', async t => {
  const e = await setup(t);
  e.bridge.pushEvent = async () => ({ ok: 0, failed: 0, details: [], reason: 'no-subscription' });
  assert.equal((await fetch(e.base + '/api/native/poll')).status, 401);
  const poll = () => fetch(e.base + '/api/native/poll', { headers: { Authorization: `Bearer ${e.config.appToken}` } });
  assert.equal((await poll()).status, 200);
  const { promise, ev } = await pending(e);
  const feed = await (await poll()).json();
  const item = feed.events.find(item => item.id === ev.id);
  assert.equal(item.replyToken, ev.replyToken);
  assert.equal(item.notify, true);
  assert.equal(item.body, undefined);
  assert.equal(item.replyTokenHash, undefined);
  assert.equal((await e.post(`/api/events/${ev.id}/decision`, { choice: 'approve', replyToken: item.replyToken }, null)).status, 200);
  assert.equal((await promise).choice, 'approve');
  const final = (await (await poll()).json()).events.find(item => item.id === ev.id);
  assert.equal(final.replyToken, null);
  assert.equal(final.notify, false);
});

test('APK 离线租期、隐藏摘要与重新配对不能复活旧请求', async t => {
  const e = await setup(t);
  e.bridge.pushEvent = async () => ({ ok: 0, failed: 0, details: [] });
  e.bridge.nativeUntil = Date.now() - 1;
  const result = await e.bridge.handleEvent({ kind: 'decision', needsDecision: true, title: 'secret', body: 'secret' });
  assert.equal(result.status, 'timeout');
  e.config.notify.contentMode = 'none';
  const poll = await fetch(e.base + '/api/native/poll', { headers: { Authorization: `Bearer ${e.config.appToken}` } });
  const item = (await poll.json()).events[0];
  assert.equal(item.title, '有新事件');
  assert.equal(item.summary, '');
  assert.equal(item.replyToken, null);
  await e.bridge.resetPairing();
  assert.equal(e.bridge.nativeUntil, 0);
});
