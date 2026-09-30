// 可选：直连 Codex app-server 的 JSON-RPC 通道。
//
// 这条路和 hooks 是**两条独立的腿**，默认关闭（data/config.json → appServer.enabled）。
// 它解决的问题：hooks 只能覆盖 Codex 主动触发的那些点，而 app-server 协议里
// "等批准 / 等回答 / 一轮完成 / 出错"全都是官方的一等公民，且就是 Codex 桌面版自己在用的通道。
//
// 已核实的协议事实（来自 codex app-server generate-json-schema 生成的 389 个 schema）：
//   服务端 → 客户端的请求（需要你回答）：
//     item/commandExecution/requestApproval     命令执行批准
//     item/fileChange/requestApproval           文件改动批准
//     item/permissions/requestApproval          权限申请
//     item/tool/requestUserInput                Codex 在问你问题（params 带 isBlocking、questions[]）
//     mcpServer/elicitation/request             MCP 服务器要输入
//   服务端 → 客户端的通知（只播报）：
//     turn/completed （带 status: completed|interrupted|failed、error.codexErrorInfo、耗时）
//     error、configWarning、thread/status/changed …
//   客户端 → 服务端的请求（我们发起的）：
//     turn/steer、thread/queue/add、turn/start、turn/interrupt
//
// 连接方式：codex app-server --listen ws://127.0.0.1:4517
//   （或者 codex remote-control start / codex app-server daemon enable-remote-control）
//
// ⚠ 注意竞争关系：桌面版也在应答同一批请求，"谁先答谁生效"。
//   所以这里的策略是：超时时间一到就**不再应答**，把决定权还给桌面版。

import { randomToken } from './crypto.mjs';

const APPROVAL_METHODS = new Map([
  ['item/commandExecution/requestApproval', { kind: 'decision', title: '需要批准：执行命令', timeout: true }],
  ['item/fileChange/requestApproval', { kind: 'decision', title: '需要批准：修改文件', timeout: true }],
  ['item/permissions/requestApproval', { kind: 'decision', title: '需要批准：权限申请', timeout: true }],
  ['item/tool/requestUserInput', { kind: 'question', title: 'Codex 在等你回答', timeout: true }],
  ['mcpServer/elicitation/request', { kind: 'question', title: 'MCP 服务在等你输入', timeout: true }],
]);

/** 把 JSON-RPC 结果按方法包装成对应的响应形状。 */
function buildApprovalResponse(method, choice, params) {
  const allow = choice === 'approve';
  if (method === 'item/commandExecution/requestApproval') {
    // 该方法的 decision 枚举：accept / acceptForSession / decline / cancel
    return { decision: allow ? 'accept' : 'decline' };
  }
  if (method === 'item/fileChange/requestApproval') {
    return { decision: allow ? 'accept' : 'decline' };
  }
  if (method === 'item/permissions/requestApproval') {
    // 权限类：给最小授权，拒绝时回空集合
    const requested = params?.permissions ?? params?.requestedPermissions ?? {};
    return { permissions: allow ? requested : {} };
  }
  if (method === 'item/tool/requestUserInput' || method === 'mcpServer/elicitation/request') {
    return { answers: params?.answers ?? {} };
  }
  return { decision: allow ? 'accept' : 'decline' };
}

/**
 * 启动 app-server 监听。
 *
 * @param {{bridge: import('./server.mjs').BridgeServer, config: object, logger: object}} deps
 */
export async function startAppServerListener({ bridge, config, logger = console }) {
  const url = config.appServer?.listen ?? 'ws://127.0.0.1:4517';
  if (typeof WebSocket !== 'function') {
    logger.warn('[appserver] 当前 Node 没有内置 WebSocket，跳过 app-server 监听（需要 Node 22+）');
    return null;
  }

  const state = {
    ws: null,
    nextId: 1,
    pending: new Map(), // id -> {resolve, reject}
    closing: false,
  };

  const send = (obj) => {
    if (!state.ws || state.ws.readyState !== 1) return false;
    state.ws.send(JSON.stringify(obj));
    return true;
  };

  const request = (method, params) =>
    new Promise((resolve, reject) => {
      const id = state.nextId++;
      state.pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
      const timer = setTimeout(() => {
        if (state.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 30_000);
      if (typeof timer.unref === 'function') timer.unref();
    });

  /** 处理一条来自服务端的请求：上报事件 → 等手机 → 回响应。 */
  async function handleServerRequest(msg) {
    const method = msg.method;
    const meta = APPROVAL_METHODS.get(method);
    if (!meta) {
      // 不认识的请求：明确回一个"不支持"，不要让它悬着
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `agent-bridge 不处理 ${method}` } });
      return;
    }

    const params = msg.params ?? {};
    const summary =
      params?.command ??
      params?.reason ??
      params?.questions?.[0]?.question ??
      params?.message ??
      `${method} 需要你的决定`;
    const waitMs = bridge.config.push?.decisionWaitMs ?? 90_000;

    try {
      const result = await bridge.handleEvent(
        {
          kind: meta.kind,
          title: meta.title,
          summary: String(summary),
          body: JSON.stringify(params, null, 2).slice(0, 4000),
          cwd: params?.cwd ?? null,
          sessionId: params?.threadId ?? params?.conversationId ?? null,
          turnId: params?.turnId ?? null,
          source: 'app-server',
          needsDecision: true,
          waitMs,
        },
        { origin: 'app-server' },
      );

      if (result.status !== 'decided') {
        // 没等到手机回答：不回响应，把决定权交回桌面版的对话框
        logger.log(`[appserver] ${method} 未在 ${waitMs} ms 内拿到手机决定，交回桌面版`);
        send({ jsonrpc: '2.0', id: msg.id, error: { code: -32001, message: 'agent-bridge: 手机未回答' } });
        return;
      }

      send({ jsonrpc: '2.0', id: msg.id, result: buildApprovalResponse(method, result.choice, params) });
      logger.log(`[appserver] ${method} 已按手机决定回传：${result.choice}`);
    } catch (err) {
      logger.error(`[appserver] 处理 ${method} 出错：${err?.message}`);
      send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: String(err?.message ?? err) } });
    }
  }

  /** 处理一条通知：只上报，不等待。 */
  async function handleNotification(msg) {
    const method = msg.method;
    const params = msg.params ?? {};

    if (method === 'turn/completed') {
      const status = params?.turn?.status ?? 'completed';
      const errorText = params?.turn?.error?.message ?? null;
      await bridge.handleEvent({
        kind: errorText || status === 'failed' ? 'error' : status === 'interrupted' ? 'notice' : 'success',
        title: errorText ? '一轮失败' : status === 'interrupted' ? '一轮被中断' : '一轮完成',
        summary: errorText ?? `用时 ${Math.round((params?.turn?.durationMs ?? 0) / 1000)} 秒（${status}）`,
        body: errorText ?? '',
        sessionId: params?.threadId ?? null,
        turnId: params?.turn?.id ?? params?.turnId ?? null,
        source: 'app-server',
        needsDecision: false,
      });
      return;
    }

    if (method === 'error') {
      await bridge.handleEvent({
        kind: 'error',
        title: 'Codex 报错',
        summary: String(params?.message ?? params?.error ?? '未知错误').slice(0, 200),
        body: JSON.stringify(params, null, 2).slice(0, 2000),
        sessionId: params?.threadId ?? null,
        turnId: params?.turnId ?? null,
        source: 'app-server',
        needsDecision: false,
      });
    }
  }

  const connect = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        headers: config.appServer?.token ? { Authorization: `Bearer ${config.appServer.token}` } : {},
      });
      state.ws = ws;
      ws.addEventListener('open', async () => {
        logger.log(`[appserver] 已连接 ${url}`);
        try {
          // 官方握手：initialize 之后必须发 initialized 通知
          const info = await request('initialize', {
            clientInfo: { name: 'agent-bridge', title: 'Agent Bridge', version: '0.1.0' },
            capabilities: {},
          });
          logger.log(`[appserver] 握手完成：${JSON.stringify(info)?.slice(0, 200)}`);
          send({ jsonrpc: '2.0', method: 'initialized', params: {} });
          resolve(ws);
        } catch (err) {
          logger.error(`[appserver] 握手失败：${err?.message}`);
          reject(err);
        }
      });
      ws.addEventListener('message', (ev) => {
        let msg = null;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
        } catch {
          logger.warn('[appserver] 收到非 JSON 消息，已忽略');
          return;
        }
        if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
          const p = state.pending.get(msg.id);
          if (p) {
            state.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error.message ?? 'JSON-RPC 错误'));
            else p.resolve(msg.result);
          }
          return;
        }
        if (msg.id !== undefined && msg.method) void handleServerRequest(msg);
        else if (msg.method) void handleNotification(msg);
      });
      ws.addEventListener('error', (err) => {
        logger.warn(`[appserver] 连接出错：${err?.message ?? '未知'}`);
        reject(new Error('WebSocket 连接失败'));
      });
      ws.addEventListener('close', () => {
        logger.log('[appserver] 连接已关闭');
        if (state.closing) return;
        // 5 秒后重连：Codex 重启、休眠唤醒都会走到这里
        setTimeout(() => {
          if (state.closing) return;
          connect().catch((err) => logger.warn(`[appserver] 重连失败：${err?.message}`));
        }, 5000).unref?.();
      });
    });

  try {
    await connect();
  } catch (err) {
    logger.warn(
      `[appserver] 连不上 ${url}（${err?.message}）。\n` +
        '    要启用它，先在另一个窗口运行：codex app-server --listen ws://127.0.0.1:4517',
    );
    return null;
  }

  return {
    close: () => {
      state.closing = true;
      try {
        state.ws?.close();
      } catch {
        /* 已经关了 */
      }
    },
    probeToken: randomToken(8),
  };
}
