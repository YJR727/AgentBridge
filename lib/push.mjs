// 推送发送层：把一条通知加密后推给所有订阅者。
//
// 关键事实（写死在这里，免得以后又忘）：
//  - Authorization: vapid t=<jwt>, k=<公钥 base64url>
//  - Content-Encoding: aes128gcm（正文已按 RFC 8291 加密）
//  - Content-Type: application/octet-stream
//  - 每条订阅单独生成 JWT（aud 是各自 endpoint 的 origin）与盐，不能复用。
//  - 404 / 410 表示订阅已失效，必须删除该订阅。

import { encryptPayload, vapidJwt, vapidAuthHeader } from './crypto.mjs';

export const TTL_SECONDS = 12 * 3600;

/**
 * @typedef {object} PushResult
 * @property {number} ok          成功条数
 * @property {number} failed      失败条数
 * @property {Array<{endpoint:string,status:number|null,error?:string,gone?:boolean}>} details
 */

/**
 * 向一组订阅发送同一个 payload。
 *
 * @param {Array} subscriptions 订阅数组（含 endpoint / keys.p256dh / keys.auth）
 * @param {object} payload 推送正文（会被 JSON 序列化）
 * @param {object} options
 * @param {{publicKey:string, privateJwk:object, subject:string}} options.vapid
 * @param {string} [options.urgency] very-low | low | normal | high
 * @param {number} [options.ttl]
 * @returns {Promise<PushResult>}
 */
export async function sendPush(subscriptions, payload, { vapid, urgency = 'high', ttl = TTL_SECONDS, timeoutMs = 10000 } = {}) {
  const body = JSON.stringify(payload);
  const details = [];
  let ok = 0;
  let failed = 0;

  // 并发发送，但每条独立处理错误，不互相影响
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        const status = await sendOne(sub, body, vapid, urgency, ttl, timeoutMs);
        if (status.ok) {
          ok += 1;
          details.push({ endpoint: sub.endpoint, status: status.code, gone: false });
        } else {
          failed += 1;
          details.push({ endpoint: sub.endpoint, status: status.code, error: status.error, gone: status.gone });
        }
      } catch (err) {
        failed += 1;
        details.push({ endpoint: sub.endpoint, status: null, error: String(err?.message ?? err), gone: false });
      }
    }),
  );

  return { ok, failed, details };
}

async function sendOne(sub, body, vapid, urgency, ttl, timeoutMs) {
  const jwt = vapidJwt(sub.endpoint, vapid.privateJwk, vapid.subject);
  const encrypted = encryptPayload(body, sub.keys.p256dh, sub.keys.auth);

  let res;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthHeader(jwt, vapid.publicKey),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body: encrypted,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    });
  } catch (err) {
    return { ok: false, code: null, error: `网络错误：${err?.message ?? err}`, gone: false };
  }

  if (res.status >= 200 && res.status < 300) {
    return { ok: true, code: res.status };
  }

  let text = '';
  try {
    text = (await res.text()).slice(0, 300);
  } catch {
    /* 读不到响应体不影响判断 */
  }
  const gone = res.status === 404 || res.status === 410;
  return { ok: false, code: res.status, error: `HTTP ${res.status} ${text}`.trim(), gone };
}

/**
 * 给订阅做一次"轻推"：只发一条最小载荷，确认端点还活着且密钥对得上。
 * 用 normal urgency + 0 TTL，避免在手机上真的弹出打扰。
 */
export async function sendProbe(subscription, vapid) {
  return sendPush([subscription], { data: { kind: 'bridge-probe', at: Date.now() } }, { vapid, urgency: 'low', ttl: 0 });
}
