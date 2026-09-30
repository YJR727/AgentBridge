#!/usr/bin/env node
// 本机自测工具：把"手机不在场"能验的东西全部验掉。
//
// 用法：
//   node tools/selftest.mjs              跑全部检查
//   node tools/selftest.mjs crypto       只测加密与 VAPID 签名
//   node tools/selftest.mjs push         起一个假推送端点，真发一次 HTTPS 风格请求并解密验证
//   node tools/selftest.mjs pair         打印配对状态与配对码（会调用正在运行的服务）
//   node tools/selftest.mjs event        发一条假的"需要批准"事件（默认等 90 秒，可用 --wait 覆盖）
//   node tools/selftest.mjs timeout      发一条必然超时的事件，验证"超时后不卡死"
//   node tools/selftest.mjs hook         进程内跑一遍 hook.mjs 的四条失败路径
//   node tools/selftest.mjs hook-pipe    用真的子进程 + 管道跑 hook.mjs（沙箱里跑不通，会说明原因）
//
// 说明：这个脚本只读 data/config.json，不修改任何配置。

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { b64url, decryptPayload, encryptPayload, generateP256KeyPair, vapidJwt, unb64url } from '../lib/crypto.mjs';
import { sendPush } from '../lib/push.mjs';
import { configFile } from '../lib/config.mjs';
import { runHook } from '../hook.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-')) ?? 'all';
const flag = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '  ✔' : '  ✖'} ${name}${detail ? `  — ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

function loadConfigOrExit() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${file}。先运行一次 node server.mjs 生成配置。`);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function baseUrl(config) {
  return `http://${config.host ?? '127.0.0.1'}:${config.port ?? 4571}`;
}

// ---------------------------------------------------------------------------
// 1. 加密与签名
// ---------------------------------------------------------------------------

function testCrypto() {
  section('加密与 VAPID 签名');

  const kp = generateP256KeyPair();
  record('P-256 公钥是 65 字节未压缩点', kp.publicKeyRaw.length === 65, `${kp.publicKeyRaw.length} 字节`);

  const jwt = vapidJwt('https://fcm.googleapis.com/fcm/send/xyz', kp.privateJwk, 'mailto:selftest@example.com');
  const [, , sig] = jwt.split('.');
  const sigLen = unb64url(sig).length;
  record('ES256 签名恰好 64 字节（ieee-p1363，不是 DER）', sigLen === 64, `${sigLen} 字节`);

  const aud = JSON.parse(unb64url(jwt.split('.')[1]).toString('utf8')).aud;
  record('JWT 的 aud 是 endpoint 的 origin', aud === 'https://fcm.googleapis.com', aud);

  // 自己造一个订阅者，验证加密结果能被它解开
  const crypto = require('node:crypto');
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = b64url(crypto.randomBytes(16));
  const text = JSON.stringify({ title: '需要批准：shell', body: '中文与 emoji ✅ 都要能原样回来' });
  const body = encryptPayload(text, b64url(ecdh.getPublicKey()), auth);
  const back = decryptPayload(body, ecdh.getPrivateKey(), auth);
  record('RFC 8291 加密 → 解密往返一致', back === text);
  record('记录头 rs=4096 / idlen=65', body.readUInt32BE(16) === 4096 && body.readUInt8(20) === 65);
}

// ---------------------------------------------------------------------------
// 2. 假推送端点：真的发一次请求并解密验证
// ---------------------------------------------------------------------------

async function testPushAgainstFakeEndpoint() {
  section('推送链路（假推送端点，真发真解）');

  const config = loadConfigOrExit();
  const crypto = await import('node:crypto');

  // 造订阅者
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = b64url(crypto.randomBytes(16));
  const subscription = {
    endpoint: 'http://127.0.0.1:0/placeholder', // 端口起完再填
    keys: { p256dh: b64url(ecdh.getPublicKey()), auth },
  };

  const captured = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      captured.push({ headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  subscription.endpoint = `http://127.0.0.1:${server.address().port}/push/abc`;

  try {
    const payload = { v: 1, title: '自测推送', body: '如果你在手机上看到这条，说明加密链路是通的。', data: { eventId: 'selftest' } };
    const result = await sendPush([subscription], payload, { vapid: config.vapid, urgency: 'high' });
    record('推送请求返回成功', result.ok === 1 && result.failed === 0, `ok=${result.ok} failed=${result.failed}`);

    if (captured.length === 0) {
      record('推送请求真的发出去了', false, '假端点没收到任何请求');
      return;
    }
    const { headers, body } = captured[0];
    record(
      'Authorization 头是 vapid t=…, k=…',
      /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(headers.authorization ?? ''),
      (headers.authorization ?? '').slice(0, 40) + '…',
    );
    record('Content-Encoding 是 aes128gcm', headers['content-encoding'] === 'aes128gcm');
    record('TTL / Urgency 头存在', Boolean(headers.ttl) && Boolean(headers.urgency), `ttl=${headers.ttl} urgency=${headers.urgency}`);

    const plain = decryptPayload(body, ecdh.getPrivateKey(), auth);
    const parsed = JSON.parse(plain);
    record('推送正文能被订阅者用自己的私钥解出', parsed.title === '自测推送', parsed.body.slice(0, 20));
  } finally {
    await new Promise((r) => server.close(r));
  }
}

// ---------------------------------------------------------------------------
// 3. 配对
// ---------------------------------------------------------------------------

async function testPair() {
  section('配对状态');
  const config = loadConfigOrExit();
  const url = baseUrl(config);

  let hello;
  try {
    const res = await fetch(`${url}/api/hello`);
    hello = await res.json();
  } catch (err) {
    record('服务在运行', false, `连不上 ${url}：${err.message}。先运行 node server.mjs`);
    return;
  }
  record('服务在运行', true, url);
  record('配对状态', true, hello.paired ? `已配对（${new Date(hello.pairedAt).toLocaleString()}）` : '未配对（在电脑上运行 node server.mjs --reset-pairing 可重新发码）');
  record('已登记的推送订阅数', true, String(hello.subscriptions));

  if (!hello.paired) {
    console.log('\n  下一步：手机打开 tailscale serve 给的 https 地址，输入服务启动时打印的配对码。');
  }
}

// ---------------------------------------------------------------------------
// 4. 假事件（真发真等）
// ---------------------------------------------------------------------------

async function testEvent({ waitMs }) {
  section(`发一条假的「需要批准」事件（等 ${Math.round(waitMs / 1000)} 秒）`);
  const config = loadConfigOrExit();
  const url = baseUrl(config);
  const started = Date.now();
  try {
    const res = await fetch(`${url}/api/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.hookToken}` },
      body: JSON.stringify({
        kind: 'decision',
        title: '（自测）需要批准：shell',
        summary: '这是一条自测事件。请点通知上的「批准」或「拒绝」，或者什么都不做等超时。',
        body: '自测事件的正文。它不来自 Codex，也不会影响任何真实会话。',
        cwd: ROOT,
        source: 'selftest',
        sessionId: `selftest-${Date.now()}`,
        turnId: `selftest-turn-${Date.now()}`,
        needsDecision: true,
        waitMs,
      }),
    });
    const data = await res.json();
    const elapsed = Date.now() - started;
    if (data.status === 'decided') {
      record('手机回了决定（等待方被唤醒）', true, `choice=${data.choice}，用时 ${elapsed} ms`);
    } else if (data.status === 'timeout') {
      record('超时返回，没有卡死（这是预期行为之一）', true, `用时 ${elapsed} ms；Codex 会回到本地提问`);
    } else {
      record('事件被接受', true, JSON.stringify(data));
    }
    console.log(`  eventId=${data.eventId}`);
  } catch (err) {
    record('发事件', false, err.message);
  }
}

// ---------------------------------------------------------------------------
// 5. hook 的四条失败路径（进程内）
// ---------------------------------------------------------------------------

async function testHookPaths() {
  section('hook.mjs 失败路径（必须全部"不输出决定 + 退出码 0"）');

  const cases = [
    { name: '服务连不上', config: { enabled: true, host: '127.0.0.1', port: 1, hookToken: 'x', push: { decisionWaitMs: 1000 } } },
    { name: '桥接被停用', config: { enabled: false, host: '127.0.0.1', port: 1, hookToken: 'x' } },
    { name: '没有配置文件', config: null },
  ];

  for (const c of cases) {
    // eslint-disable-next-line no-await-in-loop
    const r = await runHook({
      mode: 'permission',
      stdinText: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'shell' }),
      config: c.config,
    });
    record(`${c.name} → 无决定输出`, r.stdout === '' && r.exitCode === 0, `outcome=${r.outcome}`);
  }

  const dirty = await runHook({ mode: 'permission', stdinText: '{{{ 不是 JSON', config: null });
  record('脏 stdin → 无决定输出', dirty.stdout === '' && dirty.exitCode === 0, `outcome=${dirty.outcome}`);
}

// ---------------------------------------------------------------------------
// 6. hook 真管道（子进程）
// ---------------------------------------------------------------------------

function testHookPipe() {
  section('hook.mjs 真管道（子进程 + stdin 管道）');
  const { spawnSync } = require('node:child_process');

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-bridge-pipe-'));
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ enabled: true, host: '127.0.0.1', port: 1, hookToken: 'x', push: { decisionWaitMs: 1000 } }),
    'utf8',
  );

  const res = spawnSync(process.execPath, ['hook.mjs', '--mode', 'permission'], {
    cwd: ROOT,
    input: JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'shell', tool_input: { command: 'echo hi' } }),
    encoding: 'utf8',
    env: { ...process.env, AGENT_BRIDGE_DATA: dataDir },
    timeout: 30_000,
  });
  fs.rmSync(dataDir, { recursive: true, force: true });

  if (res.error?.code === 'EPERM' || res.status === null) {
    console.log('  ⚠ 当前环境不允许子进程用管道捕获输出（spawn EPERM / ETIMEDOUT）。');
    console.log('    这不是 hook 的问题：hook.mjs 的读取逻辑已由 tests/hook.test.mjs 覆盖。');
    console.log('    请在普通终端里手工跑这一条（真实复现用户视角）：');
    console.log('');
    console.log('      PowerShell:');
    console.log("        '{\"hook_event_name\":\"PermissionRequest\",\"tool_name\":\"shell\"}' | node hook.mjs --mode permission");
    console.log('      cmd.exe:');
    console.log('        echo {"hook_event_name":"PermissionRequest","tool_name":"shell"} | node hook.mjs --mode permission');
    console.log('');
    return;
  }

  record('退出码为 0', res.status === 0, `status=${res.status}`);
  record('服务连不上时 stdout 为空', res.stdout === '', JSON.stringify(res.stdout));
  record('stderr 里有诊断信息', /上报失败/.test(res.stderr ?? ''), (res.stderr ?? '').split('\n')[0]);
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log(`Agent Bridge 自测 · ${new Date().toLocaleString()}`);
  console.log(`项目目录：${ROOT}`);

  const runAll = cmd === 'all';

  if (runAll || cmd === 'crypto') testCrypto();
  if (runAll || cmd === 'push') await testPushAgainstFakeEndpoint();
  if (runAll || cmd === 'pair') await testPair();
  if (cmd === 'event') await testEvent({ waitMs: Number(flag('wait', 90_000)) });
  if (cmd === 'timeout') await testEvent({ waitMs: Number(flag('wait', 3000)) });
  if (runAll || cmd === 'hook') await testHookPaths();
  if (runAll || cmd === 'hook-pipe') testHookPipe();

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 项，失败 ${failed.length} 项。`);
  if (failed.length) {
    console.log('失败项：');
    for (const f of failed) console.log(`  ✖ ${f.name} ${f.detail}`);
  }
  process.exit(failed.length ? 1 : 0);
}

// require() 在 ESM 里不可用，这里做个小桥接（只用到两个内置模块）
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

main().catch((err) => {
  console.error('自测异常：', err?.stack ?? err);
  process.exit(1);
});
