#!/usr/bin/env node
// Agent Bridge 服务端入口。
//
// 用法：
//   node server.mjs                  正常启动
//   node server.mjs --reset-pairing  重新生成配对码并打开配对入口（换手机/重装时用）
//   node server.mjs --print-config   打印当前配置（令牌打码）后退出
//   node server.mjs --check          只做一次自检（配置、端口、密钥）后退出
//
// 环境变量：
//   AGENT_BRIDGE_DATA  覆盖 data/ 目录位置（自测时用临时目录，不污染真实数据）
//   AGENT_BRIDGE_PORT  覆盖端口

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';

import { configFile, dataDir, loadConfig, saveConfig } from './lib/config.mjs';
import { Store } from './lib/store.mjs';
import { BridgeServer } from './lib/server.mjs';
import { DesktopSessions } from './lib/desktop-sessions.mjs';

const args = new Set(process.argv.slice(2));

function mask(token) {
  if (!token) return '(空)';
  return `${String(token).slice(0, 6)}…${String(token).slice(-4)}（共 ${String(token).length} 字符）`;
}

function printConfig(config) {
  const safe = JSON.parse(JSON.stringify(config));
  safe.hookToken = mask(safe.hookToken);
  safe.appToken = mask(safe.appToken);
  if (safe.vapid?.privateJwk) safe.vapid.privateJwk = '(已隐藏)';
  console.log(JSON.stringify(safe, null, 2));
}

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

async function main() {
  const { config, created, generated } = loadConfig();

  if (process.env.AGENT_BRIDGE_PORT) config.port = Number(process.env.AGENT_BRIDGE_PORT);

  if (args.has('--print-config')) {
    console.log(`配置文件：${configFile()}`);
    printConfig(config);
    return;
  }

  const store = new Store(dataDir());
  const logger = {
    log: (...a) => console.log(`[${new Date().toISOString()}]`, ...a),
    warn: (...a) => console.warn(`[${new Date().toISOString()}]`, ...a),
    error: (...a) => console.error(`[${new Date().toISOString()}]`, ...a),
  };

  if (created) {
    logger.log(`首次运行：已生成 ${configFile()}`);
    if (generated.length) logger.log(`自动生成/补齐的字段：${generated.join('、')}`);
    logger.log(`VAPID 公钥：${config.vapid.publicKey.slice(0, 24)}…`);
    if (config.vapid.subject.endsWith('@localhost')) {
      logger.warn('提示：data/config.json 里的 vapid.subject 现在是占位邮箱，建议改成你自己的邮箱（推送服务商需要用它联系你）。');
    }
  }

  if (args.has('--reset-pairing')) {
    const occupied = await new Promise(resolve => {
      const socket = net.connect({ host: '127.0.0.1', port: config.port });
      socket.setTimeout(1000);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('error', () => resolve(false));
      socket.once('timeout', () => { socket.destroy(); resolve(true); });
    });
    if (occupied) throw new Error('请先停止已有服务再重新配对，避免两个进程使用不同凭证');
    const resetBridge = new BridgeServer({ store, config, logger });
    await resetBridge.resetPairing();
    logger.log('已撤销旧手机凭证、订阅和待处理请求，稍后会打印新的配对码。');
  }

  const desktop = new DesktopSessions({ logger, dataDirectory: dataDir() });
  const bridge = new BridgeServer({ store, config, logger, desktop });

  if (args.has('--check')) {
    // 只做静态自检，不监听端口
    const problems = [];
    if (config.host !== '127.0.0.1') problems.push(`host 应为 127.0.0.1，当前是 ${config.host}（不要直接暴露到局域网）`);
    if (!config.vapid.publicKey || !config.vapid.privateJwk) problems.push('VAPID 密钥缺失');
    if (!config.hookToken || !config.appToken) problems.push('令牌缺失');
    const waitMs = config.push.decisionWaitMs;
    if (waitMs >= 300_000) problems.push(`decisionWaitMs=${waitMs} 太大，hooks 的 timeoutSec 会先到，手机永远等不到`);
    console.log(problems.length ? `自检发现 ${problems.length} 个问题：` : '自检通过。');
    for (const p of problems) console.log(`  - ${p}`);
    process.exitCode = problems.length ? 1 : 0;
    return;
  }

  // Reuse only a verified compatible service. Never kill a process on this port.
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/api/health`, {signal:AbortSignal.timeout(1200)});
    const existing = await response.json();
    if (existing.ok && existing.version === '0.4.0' && existing.addDevicePairing === true && existing.independentChats === true) { logger.log('已有兼容服务正在运行，已复用；可关闭此重复窗口。'); return; }
    throw new Error('端口上是旧版本或其他服务。请关闭旧手机桥窗口，再双击 start.cmd。');
  } catch (error) { if (error.message.includes('旧版本')) throw error; }
  const address = await bridge.start();
  const port = typeof address === 'object' && address ? address.port : config.port;
  logger.log(`Agent Bridge 已启动：http://${config.host}:${port}`);
  logger.log(`事件上限 300 条 · 数据目录 ${dataDir()} · 需要决定的等待上限 ${config.push.decisionWaitMs} ms`);

  if (!bridge.paired) {
    const code = bridge.issuePairCode();
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log(`  │  手机配对码： ${code}                      │`);
    console.log('  └──────────────────────────────────────────────┘');
    console.log('  手机打开 tailscale serve 提供的 https 地址，输入这个码即可。');
    console.log('  配对成功后配对入口会自动关闭。换手机请运行：node server.mjs --reset-pairing');
    console.log('');
  } else {
    logger.log(`已完成配对（${new Date(config.pairedAt).toLocaleString()}），配对入口保持关闭。`);
  }

  logger.log('手机可选择已有 Codex 聊天；请先在电脑打开要控制的聊天。');

  const shutdown = async (signal) => {
    if (shutdown.started) return;
    shutdown.started = true;
    logger.log(`收到 ${signal}，正在停止…`);
    try {
      desktop.stop();
      await bridge.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  if (args.has('--desktop')) {
    const {createInterface} = await import('node:readline');
    const commands = createInterface({input:process.stdin});
    commands.on('line', line => { if (line === 'shutdown') void shutdown('desktop'); });
    // Closing the controller also closes its pipe; do not leave its service orphaned.
    commands.on('close', () => void shutdown('desktop-closed'));
  }

  // 每天清一次 30 天前的事件，避免文件无限增长
  const cleanupTimer = setInterval(() => {
    void store.cleanup().catch((err) => logger.error(`清理失败：${err?.message}`));
  }, 24 * 3600 * 1000);
  cleanupTimer.unref();
}

main().catch((err) => {
  console.error('启动失败：', err?.stack ?? err);
  process.exit(1);
});
