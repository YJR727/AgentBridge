#!/usr/bin/env node
// Codex hook 适配器：读 stdin 的 hook JSON，上报事件；需要决定时阻塞等待手机回答。
//
// 设计铁律（来自需求第 6 节"交互与失败处理"）：
//   - 手机不在线、没配对、推送失败、服务没起来 → 一律"不输出决定、正常退出"，
//     让 Codex 回到电脑本地提问。手机上永远不能变成单点故障。
//   - 等待有上限，且必须小于 hooks.json 里该 hook 的 timeout（秒）。
//   - 任何异常都不许把 Codex 卡死，也不许输出半截决定。
//
// 用法：
//   hook.mjs --mode notice      完成/失败类，只上报不等待（Stop / SessionEnd / PostToolUse 等）
//   hook.mjs --mode permission  需要决定类，上报后等待手机回答（PermissionRequest）
//   hook.mjs --mode question    提问类，上报后等待手机回答（UserPromptSubmit 等）
//
// 自测：
//   echo '{"hook_event_name":"PermissionRequest","session_id":"s1"}' | node hook.mjs --mode permission

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

// ---------------------------------------------------------------------------
// 配置：直接读 data/config.json（不能用 lib/config.mjs，因为它会生成密钥——hook 不该有副作用）
// ---------------------------------------------------------------------------

function readConfig() {
  const dataDir = process.env.AGENT_BRIDGE_DATA
    ? path.resolve(process.env.AGENT_BRIDGE_DATA)
    : path.join(ROOT, 'data');
  const file = path.join(dataDir, 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// stdin
// ---------------------------------------------------------------------------

async function readStdin(timeoutMs = 3000) {
  if (process.stdin.isTTY) return '';
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(data);
    };
    const timer = setTimeout(finish, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      clearTimeout(timer);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(timer);
      finish();
    });
  });
}

// ---------------------------------------------------------------------------
// 事件摘要
// ---------------------------------------------------------------------------

/** 从 hook 输入里挑出"给人看"的字段，避免把整个 tool_input 塞进通知。 */
function buildEvent(mode, hook, { runningAsWrapper = false } = {}) {
  const name = hook.hook_event_name ?? 'unknown';
  const base = {
    sessionId: hook.session_id ?? null,
    requestId: hook.tool_use_id ?? hook.request_id ?? hook.item_id ?? null,
    turnId: hook.turn_id ?? null,
    cwd: hook.cwd ?? null,
    hookEventName: name,
    source: runningAsWrapper ? 'notify-wrapper' : 'codex-hook',
    agentId: hook.agent_id ?? null,
    model: hook.model ?? null,
    permissionMode: hook.permission_mode ?? null,
  };

  if (mode === 'permission') {
    const toolName = hook.tool_name ?? '未知工具';
    const reason = hook.tool_input?.description ?? hook.permission_request_reason ?? hook.reason ?? null;
    const detail = safeStringify(hook.tool_input);
    return {
      ...base,
      kind: 'decision',
      needsDecision: true,
      title: `需要批准：${toolName}`,
      summary: reason ? truncate(reason, 140) : summarizeToolInput(toolName, hook.tool_input),
      body: [reason ? `理由：${reason}` : null, `工具：${toolName}`, detail ? `参数：${detail}` : null]
        .filter(Boolean)
        .join('\n'),
      toolName,
      actions: [
        { id: 'approve', label: '批准' },
        { id: 'deny', label: '拒绝' },
      ],
    };
  }

  // notice：完成 / 出错 / 会话结束
  const isStop = name === 'Stop' || name === 'SubagentStop';
  const last = hook.last_assistant_message ?? '';
  const errorText = hook.error ?? hook.error_message ?? null;
  const kind = errorText ? 'error' : isStop ? 'success' : 'notice';
  return {
    ...base,
    kind,
    needsDecision: false,
    title: errorText ? `出错了：${name}` : isStop ? '一轮结束' : `事件：${name}`,
    summary: errorText ? truncate(errorText, 200) : truncate(last, 200) || `${name} 事件`,
    body: errorText ? String(errorText).slice(0, 4000) : String(last).slice(0, 4000),
  };
}

function summarizeToolInput(toolName, input) {
  if (!input || typeof input !== 'object') return `${toolName} 请求执行`;
  if (typeof input.command === 'string') return truncate(input.command, 200);
  if (typeof input.path === 'string') return `文件：${truncate(input.path, 180)}`;
  if (typeof input.url === 'string') return `网址：${truncate(input.url, 180)}`;
  return `${toolName} 请求执行`;
}

function truncate(str, max) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function safeStringify(value) {
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

// ---------------------------------------------------------------------------
// 上报
// ---------------------------------------------------------------------------

async function report(config, event, { waitMs, enabled, timeoutMs, fetchImpl = globalThis.fetch }) {
  const url = `http://${config.host ?? '127.0.0.1'}:${config.port ?? 4571}/api/event`;
  const controller = new AbortController();
  // 本地等待 waitMs 之后，网络层再给 5 秒宽限，然后放弃
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.hookToken}`,
      },
      body: JSON.stringify({ ...event, enabled, waitMs, timeoutMs }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, error: `HTTP ${res.status} ${text.slice(0, 200)}` };
    }
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err?.message ?? err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 主流程（导出出来，方便 tools/selftest.mjs 在进程内直接跑，无需 spawn）
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {'notice'|'permission'|'question'} options.mode
 * @param {string} options.stdinText  hook JSON 文本
 * @param {object|null} options.config
 * @param {(msg:string)=>void} [options.log]  诊断日志（走 stderr）
 * @param {(url:string, init:object)=>Promise<any>} [options.fetchImpl] 注入用
 * @returns {Promise<{exitCode:number, stdout:string, stderr:string, outcome:string, decision:object|null}>}
 */
export async function runHook({
  mode,
  stdinText,
  config,
  log = () => {},
  fetchImpl = globalThis.fetch,
} = {}) {
  const stderrLines = [];
  const write = (msg) => {
    stderrLines.push(msg);
    log(msg);
  };

  if (!config) {
    write('没有找到 data/config.json，hook 不输出任何决定，直接退出。');
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'no-config', decision: null };
  }
  if (config.enabled === false) {
    write('桥接已被停用（enabled=false），hook 不输出任何决定，直接退出。');
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'disabled', decision: null };
  }

  let hook;
  try {
    hook = JSON.parse(stdinText.replace(/^\uFEFF/, ''));
  } catch (err) {
    write(`stdin 不是合法 JSON：${err.message}；忽略本次调用。`);
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'bad-input', decision: null };
  }

  if (!hook || typeof hook !== 'object' || Array.isArray(hook) ||
      (mode === 'permission' && hook.hook_event_name !== 'PermissionRequest') ||
      (mode === 'permission' && (!hook.tool_name || hook.tool_input == null)) ||
      !['permission', 'notice'].includes(mode)) {
    write('不支持这个事件/模式，不输出决定。');
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'unsupported', decision: null };
  }

  const waitMs = Math.min(
    Math.max(1000, Number(config.push?.decisionWaitMs) || 90_000),
    Math.max(1000, Number(config.push?.decisionWaitMaxMs) || 240_000),
    90_000,
  );
  const timeoutMs = mode === 'permission' ? waitMs + 5000 : 1500;
  const event = buildEvent(mode, hook);
  write(`mode=${mode} event=${hook.hook_event_name ?? '?'} kind=${event.kind} waitMs=${event.needsDecision ? waitMs : 0}`);

  const result = await report(config, event, { waitMs, enabled: true, timeoutMs, fetchImpl });

  if (!result.ok) {
    write(`上报失败（${result.error}）→ 不输出决定，交回本地提问。`);
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'report-failed', decision: null };
  }

  const data = result.data ?? {};
  write(`上报成功 status=${data.status} eventId=${data.eventId ?? '-'}`);

  if (!event.needsDecision) {
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'reported', decision: null };
  }

  if (data.status !== 'decided' || !['approve', 'deny'].includes(data.choice)) {
    write(
      data.status === 'timeout'
        ? `手机在 ${waitMs} ms 内没有回答 → 不输出决定，Codex 回到本地提问。`
        : `没有拿到有效决定（status=${data.status}）→ 不输出决定。`,
    );
    return { exitCode: 0, stdout: '', stderr: stderrLines.join('\n'), outcome: 'timeout', decision: null };
  }

  const choice = String(data.choice);
  const note = data.note ? `（手机附言：${truncate(data.note, 300)}）` : '';
  const stdout = `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: hook.hook_event_name ?? 'PermissionRequest',
      decision: choice === 'approve' ? { behavior: 'allow' } : {
        behavior: 'deny', message: `经 Agent Bridge 手机端拒绝${note}`,
      },
    },
  })}\n`;

  write(`收到决定 choice=${choice} → 输出 decision.behavior=${choice === 'approve' ? 'allow' : 'deny'}`);
  return { exitCode: 0, stdout, stderr: stderrLines.join('\n'), outcome: 'decided', decision: { choice, note: data.note ?? null } };
}


// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const out = { mode: 'notice', notifyWrapper: false, help: false, printConfig: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a.startsWith('--mode=')) out.mode = a.slice(7);
    else if (a === '--notify-wrapper') out.notifyWrapper = true;
    else if (a === '--print-config') out.printConfig = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  if (!['notice', 'permission', 'question'].includes(out.mode)) out.mode = 'notice';
  return out;
}

const HELP = `
Agent Bridge hook 适配器

  node hook.mjs --mode notice       完成/失败类事件，只上报不等待
  node hook.mjs --mode permission   需要决定类事件，上报后等待手机回答
  文字回答未接入，question 模式不输出任何决定。
  node hook.mjs --print-config      打印它读到的桥接配置（令牌打码）

行为约定：
  任何失败（服务没起来 / 没配对 / 超时 / 输入不是 JSON）都不会输出决定，
  退出码一律 0，让 Codex 回到电脑本地提问。手机上不会变成单点故障。
`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }

  const config = readConfig();
  if (args.printConfig) {
    const safe = config ? { ...config, hookToken: '(已隐藏)', appToken: '(已隐藏)', vapid: { publicKey: '(隐藏)', privateJwk: '(隐藏)', subject: config.vapid?.subject } } : null;
    process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
    return;
  }

  const stdinText = await readStdin();
  const result = await runHook({
    mode: args.mode,
    stdinText,
    config,
    log: (msg) => process.stderr.write(`[hook] ${msg}\n`),
  });
  if (result.stdout) process.stdout.write(result.stdout);
  process.exitCode = result.exitCode;
}

// 只有被当作脚本直接运行时才走 CLI；被 import 时只导出 runHook
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    // 兜底：绝不让异常变成非 0 退出码或半截 stdout
    process.stderr.write(`[hook] 未捕获异常，安全退出（不输出决定）：${err?.stack ?? err}\n`);
    process.exitCode = 0;
  });
}

export { buildEvent, readConfig, HELP };
