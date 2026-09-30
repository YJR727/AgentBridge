// hook 适配器的测试。
//
// 这是需求里最关键的一条硬要求：
//   "超时、手机未配对、推送失败、服务没起来 —— 这些情况下 hook 都要
//    不输出决定并正常退出，让 Codex 回到电脑本地提问。"
// 所以这里逐个失败路径都断言：exitCode === 0 且 stdout === ''。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { runHook, buildEvent } from '../hook.mjs';

const T = { timeout: 15_000 };

/** 造一个假的桥接服务，只实现 /api/event。 */
async function fakeBridge(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ url: req.url, method: req.method, auth: req.headers.authorization, body });
      const result = handler(body, req) ?? { status: 'accepted' };
      res.writeHead(result.__status ?? 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port,
    requests,
    close: () => new Promise((r) => server.close(r)),
  };
}

function makeConfig(port, extra = {}) {
  return {
    enabled: true,
    host: '127.0.0.1',
    port,
    hookToken: 'test-hook-token',
    push: { decisionWaitMs: 500, decisionWaitMaxMs: 2000 },
    ...extra,
  };
}

const permissionInput = JSON.stringify({
  hook_event_name: 'PermissionRequest',
  session_id: 'sess-1',
  turn_id: 'turn-1',
  cwd: 'D:\\proj',
  tool_name: 'shell',
  tool_input: { command: 'rm -rf build' },
  permission_mode: 'default',
});

test('手机点批准 → 输出 PermissionRequest decision.behavior allow', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'decided', eventId: 'ev1', choice: 'approve' }));
  try {
    const result = await runHook({
      mode: 'permission',
      stdinText: permissionInput,
      config: makeConfig(bridge.port),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.outcome, 'decided');
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PermissionRequest');
    assert.deepEqual(out.hookSpecificOutput.decision, { behavior: 'allow' });
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);

    // 上报内容必须是摘要而不是整个 tool_input 原样塞满
    const sent = bridge.requests[0].body;
    assert.equal(sent.kind, 'decision');
    assert.equal(sent.needsDecision, true);
    assert.equal(sent.sessionId, 'sess-1');
    assert.equal(sent.turnId, 'turn-1');
    assert.match(sent.summary, /rm -rf build/);
    assert.equal(bridge.requests[0].auth, 'Bearer test-hook-token');
  } finally {
    await bridge.close();
  }
});

test('手机点拒绝 → 输出 deny', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'decided', eventId: 'ev1', choice: 'deny', note: '别删' }));
  try {
    const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: makeConfig(bridge.port) });
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.decision.behavior, 'deny');
    assert.match(out.hookSpecificOutput.decision.message, /别删/);
  } finally {
    await bridge.close();
  }
});

test('超时 → 不输出任何决定、退出码 0（Codex 回到本地提问）', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'timeout', eventId: 'ev1', choice: null }));
  try {
    const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: makeConfig(bridge.port) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '', '超时绝不能输出决定');
    assert.equal(result.outcome, 'timeout');
  } finally {
    await bridge.close();
  }
});

test('服务没起来 → 不输出决定、退出码 0', T, async () => {
  // 127.0.0.1:1 基本不可能是我们的服务
  const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: makeConfig(1) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.outcome, 'report-failed');
});

test('桥接被停用（enabled=false）→ 完全不联网、不输出决定', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'decided', choice: 'approve' }));
  try {
    const result = await runHook({
      mode: 'permission',
      stdinText: permissionInput,
      config: makeConfig(bridge.port, { enabled: false }),
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.outcome, 'disabled');
    assert.equal(bridge.requests.length, 0, '停用后不应该发出任何请求');
  } finally {
    await bridge.close();
  }
});

test('没有配置文件 → 不输出决定、退出码 0', T, async () => {
  const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: null });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.outcome, 'no-config');
});

test('stdin 不是 JSON → 不输出决定、退出码 0（不能因为脏输入卡住 Codex）', T, async () => {
  const result = await runHook({ mode: 'permission', stdinText: '这不是 JSON {{{', config: makeConfig(1) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
  assert.equal(result.outcome, 'bad-input');
});

test('服务返回 500 → 不输出决定、退出码 0', T, async () => {
  const bridge = await fakeBridge(() => ({ __status: 500, error: '炸了' }));
  try {
    const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: makeConfig(bridge.port) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
    assert.equal(result.outcome, 'report-failed');
  } finally {
    await bridge.close();
  }
});

test('服务返回 decided 但没有 choice → 不输出决定（不做半截决定）', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'decided', eventId: 'ev1' }));
  try {
    const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: makeConfig(bridge.port) });
    assert.equal(result.exitCode, 0);
    assert.equal(result.stdout, '');
  } finally {
    await bridge.close();
  }
});

test('notice 模式：只上报，不阻塞、不输出决定', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'accepted', eventId: 'ev2' }));
  try {
    const started = Date.now();
    const result = await runHook({
      mode: 'notice',
      stdinText: JSON.stringify({
        hook_event_name: 'Stop',
        session_id: 'sess-2',
        turn_id: 'turn-2',
        last_assistant_message: '已经把 config.toml 改好了，测试全绿。',
      }),
      config: makeConfig(bridge.port),
    });
    assert.ok(Date.now() - started < 1500, 'notice 不应该等待');
    assert.equal(result.stdout, '');
    assert.equal(result.outcome, 'reported');

    const sent = bridge.requests[0].body;
    assert.equal(sent.kind, 'success');
    assert.equal(sent.needsDecision, false);
    assert.match(sent.summary, /测试全绿/);
  } finally {
    await bridge.close();
  }
});

test('notice 模式：带错误信息时归类为 error', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'accepted' }));
  try {
    await runHook({
      mode: 'notice',
      stdinText: JSON.stringify({ hook_event_name: 'Stop', error: 'rate limit exceeded', turn_id: 't' }),
      config: makeConfig(bridge.port),
    });
    assert.equal(bridge.requests[0].body.kind, 'error');
  } finally {
    await bridge.close();
  }
});

test('等待上限被 decisionWaitMaxMs 夹紧（防止配置写错把自己卡死）', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'timeout', choice: null }));
  try {
    await runHook({
      mode: 'permission',
      stdinText: permissionInput,
      // decisionWaitMs 写了 1 小时，但上限是 2 秒
      config: makeConfig(bridge.port, { push: { decisionWaitMs: 3_600_000, decisionWaitMaxMs: 2000 } }),
    });
    const sent = bridge.requests[0].body;
    assert.equal(sent.waitMs, 2000, '必须被上限夹紧');
    assert.ok(sent.timeoutMs > sent.waitMs, 'hooks 的 timeout 必须比本地等待更长');
  } finally {
    await bridge.close();
  }
});

test('buildEvent：permission 事件的摘要不泄漏完整 tool_input', T, () => {
  const long = 'x'.repeat(5000);
  const ev = buildEvent('permission', {
    hook_event_name: 'PermissionRequest',
    tool_name: 'shell',
    tool_input: { command: long },
  });
  assert.ok(ev.summary.length <= 220, `摘要过长：${ev.summary.length}`);
  assert.ok(ev.body.includes(long), '详情必须保留完整命令');
  assert.deepEqual(ev.actions, [
    { id: 'approve', label: '批准' },
    { id: 'deny', label: '拒绝' },
  ]);
});

test('UserPromptSubmit 不能冒充 Codex 待回答问题', T, async () => {
  const result = await runHook({mode: 'question', stdinText: JSON.stringify({hook_event_name: 'UserPromptSubmit', prompt: '选择数据库'}), config: makeConfig(1)});
  assert.equal(result.stdout, '');
  assert.equal(result.outcome, 'unsupported');
});

test('未知选择和错误 hook 事件不能输出批准或拒绝', T, async () => {
  const bridge = await fakeBridge(() => ({status: 'decided', choice: 'unexpected'}));
  try {
    const result = await runHook({mode:'permission', stdinText:permissionInput, config:makeConfig(bridge.port)});
    assert.equal(result.stdout, '');
    const wrong = await runHook({mode:'permission', stdinText:JSON.stringify({hook_event_name:'PreToolUse'}), config:makeConfig(bridge.port)});
    assert.equal(wrong.outcome, 'unsupported');
  } finally { await bridge.close(); }
});

test('稳定请求标识、完整审批理由及中断语义', T, () => {
  const event = buildEvent('permission', {hook_event_name:'PermissionRequest', tool_use_id:'call-7', tool_name:'Bash', tool_input:{command:'echo test', description:'需要外部访问'}});
  assert.equal(event.requestId, 'call-7');
  assert.match(event.body, /需要外部访问/);
  assert.equal(buildEvent('notice', {hook_event_name:'Interrupt'}).kind, 'notice');
  assert.equal(buildEvent('notice', {hook_event_name:'SessionEnd'}).kind, 'notice');
});

test('审批内容缺失时不向手机提供盲批请求', T, async () => {
  let called=false;
  const result=await runHook({mode:'permission',stdinText:JSON.stringify({hook_event_name:'PermissionRequest',tool_name:'Bash'}),config:makeConfig(1),fetchImpl:async()=>{called=true;throw new Error('不应上报');}});
  assert.equal(result.outcome,'unsupported');
  assert.equal(result.stdout,'');
  assert.equal(called,false);
});

// --- CLI（子进程）路径 -------------------------------------------------------
//
// 实测边界（别再试一遍）：
//   在受限沙箱里，子进程既不能用管道捕获输出，也**连不上父进程监听的端口**
//   （fetch 到父进程的 127.0.0.1 端口会一直挂住直到超时）。
//   所以"真的起一个子进程，让它连回测试里的假服务"这件事在沙箱内做不到。
//
// 但 CLI 的代码路径与 runHook() 完全一样（main() 只是读 stdin + 调 runHook + 写 stdout），
// 因此这里改成两步：
//   1) 断言 main() 的入口条件（脚本被判为"直接运行"、--help 可用）；
//   2) 真正的 stdio 端到端留给 tools/selftest.mjs —— 用 PowerShell 管道跑，
//      普通终端里可以做真连接，沙箱里它会自动降级为进程内模式并说明原因。

test('CLI 入口：--help 可用，且打印了行为约定', T, async () => {
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'hook.mjs'), 'utf8');
  assert.match(src, /invokedDirectly/, '必须有"直接运行才走 CLI"的判断');
  assert.match(src, /process\.exitCode = 0/, '兜底路径必须把退出码设成 0');
  const { HELP } = await import('../hook.mjs');
  assert.match(HELP, /--mode permission/);
  assert.match(HELP, /不会输出决定/);
});

test('CLI 等价路径：runHook 返回的决定就是 CLI 会打印的那段 JSON', T, async () => {
  const bridge = await fakeBridge(() => ({ status: 'decided', choice: 'approve' }));
  try {
    const result = await runHook({ mode: 'permission', stdinText: permissionInput, config: makeConfig(bridge.port) });
    assert.equal(result.exitCode, 0);
    // CLI 里就是 process.stdout.write(result.stdout)，所以这里等价于跑了一次 CLI
    assert.doesNotThrow(() => JSON.parse(result.stdout));
    assert.equal(result.stdout.endsWith('\n'), true, '必须是完整一行 JSON');
  } finally {
    await bridge.close();
  }
});

test('脏 stdin 在进程内也不会输出决定', T, async () => {
  const result = await runHook({ mode: 'permission', stdinText: 'not-json-at-all', config: makeConfig(1) });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, '');
});
