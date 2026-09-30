#!/usr/bin/env node
// notify 包装脚本：串接「你原来的 notify 程序」+「上报给 Agent Bridge」。
//
// 为什么需要它：Codex 的 config.toml 里 notify 只能有一行，而那一行已经被
// computer-use 的 turn-ended 钩子占用了（硬约束：不许动它）。所以做法是
// 把 notify 指向本脚本，由本脚本先调用原来的程序，再把事件发给桥接服务。
//
// 三条铁律：
//   1. 绝不阻塞 Codex 收尾：上报带 3 秒超时，超时就放弃。
//   2. 原程序的行为必须完整保留：先调用它，把它的退出码原样返回。
//   3. 一键还原：tools/install.mjs --uninstall 会把 config.toml 的 notify 行
//      改回原来的值（原值就存在 data/config.json 的 notifyWrapper.original 里）。
//
// 配置来源：data/config.json
//   notifyWrapper.original  原来那一行 notify 数组（安装时自动探测填写）
//   notifyWrapper.url       上报地址，默认 http://127.0.0.1:4571/api/notify
//
// 单独测试：
//   node notify-wrapper.mjs turn-ended            # 会调用原程序并上报一次
//   node notify-wrapper.mjs --dry-run             # 只打印将要做什么，不真的执行

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function dataDir() {
  return process.env.AGENT_BRIDGE_DATA ? path.resolve(process.env.AGENT_BRIDGE_DATA) : path.join(ROOT, 'data');
}

function loadConfig() {
  const file = path.join(dataDir(), 'config.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    process.stderr.write(`[notify-wrapper] 读不到 ${file}：${err.message}\n`);
    return null;
  }
}

/** 把原始 notify 程序跑起来，返回退出码。 */
function runOriginal(original, args) {
  return new Promise((resolve) => {
    if (!Array.isArray(original) || original.length === 0) {
      // 没有原始程序（用户本来就没配）：直接当成功
      resolve(0);
      return;
    }
    const [cmd, ...baseArgs] = original;
    if (path.resolve(cmd) === fileURLToPath(import.meta.url)) {
      process.stderr.write('[notify-wrapper] 检测到自我递归配置（original 指向了包装脚本自己），已跳过原程序调用。\n');
      resolve(0);
      return;
    }
    let child;
    try {
      child = spawn(cmd, [...baseArgs, ...args], {
        stdio: 'ignore', // 必须：不能让原程序的输出污染 Codex 的 stdout
        windowsHide: true,
        detached: false,
      });
    } catch (err) {
      process.stderr.write(`[notify-wrapper] 调用原 notify 程序失败：${err.message}\n`);
      resolve(0); // 原程序起不来也不能让 Codex 出错
      return;
    }
    child.on('error', (err) => {
      process.stderr.write(`[notify-wrapper] 原 notify 程序出错：${err.message}\n`);
      resolve(0);
    });
    child.on('exit', (code) => resolve(code ?? 0));
    // 原程序卡住不能拖死 Codex：10 秒后放行
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* 已经退出了 */
      }
      resolve(0);
    }, 10_000);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/** 上报给桥接服务。永不阻塞：3 秒超时，失败只写 stderr。 */
async function report(config, payload) {
  const url = config?.notifyWrapper?.url ?? 'http://127.0.0.1:4571/api/notify';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  if (typeof timer.unref === 'function') timer.unref();
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.hookToken}` },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      process.stderr.write(`[notify-wrapper] 上报失败：HTTP ${res.status}\n`);
    }
    return res.ok;
  } catch (err) {
    process.stderr.write(`[notify-wrapper] 上报失败（忽略，不影响 Codex）：${err?.message ?? err}\n`);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** 从命令行参数里尽量提取会话/轮次信息（Codex 的 notify 只给 JSON 或少量参数）。 */
function extractContext(args) {
  const ctx = { sessionId: null, turnId: null, cwd: process.cwd(), summary: null };
  for (const a of args) {
    if (typeof a !== 'string') continue;
    const trimmed = a.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      ctx.sessionId = parsed.session_id ?? parsed.sessionId ?? ctx.sessionId;
      ctx.turnId = parsed.turn_id ?? parsed.turnId ?? ctx.turnId;
      ctx.cwd = parsed.cwd ?? ctx.cwd;
      ctx.summary = parsed.last_assistant_message ?? parsed.message ?? ctx.summary;
    } catch {
      /* 不是 JSON 就忽略 */
    }
  }
  return ctx;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const args = argv.filter((a) => a !== '--dry-run');

  const config = loadConfig();

  if (dryRun) {
    process.stdout.write(
      `${JSON.stringify(
        {
          原始 notify 程序: config?.notifyWrapper?.original ?? [],
          本次参数: args,
          桥接启用: config?.enabled !== false,
          上报地址: config?.notifyWrapper?.url ?? 'http://127.0.0.1:4571/api/notify',
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  // 桥接停用：完全不改变行为，只调用原程序
  if (!config || config.enabled === false) {
    const code = await runOriginal(config?.notifyWrapper?.original ?? [], args);
    process.exitCode = code;
    return;
  }

  // 1) 先调用原程序（保持原有行为与退出码）
  const code = await runOriginal(config.notifyWrapper?.original ?? [], args);

  // 2) 再上报一轮结束事件（不阻塞）
  const ctx = extractContext(args);
  await report(config, {
    title: 'Codex 一轮结束',
    summary: ctx.summary ?? `notify ${args.join(' ') || 'turn-ended'}`.slice(0, 200),
    body: ctx.summary ?? '',
    sessionId: ctx.sessionId,
    turnId: ctx.turnId,
    cwd: ctx.cwd,
    source: 'notify-wrapper',
  });

  process.exitCode = code;
}

main().catch((err) => {
  process.stderr.write(`[notify-wrapper] 未捕获异常（已忽略）：${err?.stack ?? err}\n`);
  process.exitCode = 0;
});
