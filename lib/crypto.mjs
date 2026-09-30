// 零依赖密码学工具层。
// 只做四件事：base64url 编解码、P-256 密钥生成、VAPID 的 ES256 JWT 签名、RFC 8291 的 aes128gcm 正文加密。
// 全部用 node:crypto，不引第三方库。

import crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------

/** 把 Buffer 编成不带 padding 的 base64url 字符串。 */
export function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 把 base64url（或普通 base64）字符串解成 Buffer。 */
export function unb64url(str) {
  if (typeof str !== 'string') throw new TypeError('unb64url 需要字符串');
  let s = str.trim().replace(/-/g, '+').replace(/_/g, '/');
  // 容忍浏览器/服务端给来的带 padding 或缺失 padding 的输入
  const pad = s.length % 4;
  if (pad === 1) throw new Error('非法的 base64url 长度');
  if (pad) s += '='.repeat(4 - pad);
  return Buffer.from(s, 'base64');
}

/** 把 ArrayBuffer / TypedArray / base64url 字符串统一解成 Buffer。 */
export function toBuffer(value, label = 'value') {
  if (value == null) throw new TypeError(`${label} 缺失`);
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return Buffer.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  if (typeof value === 'string') return unb64url(value);
  throw new TypeError(`${label} 类型不支持：${typeof value}`);
}

// ---------------------------------------------------------------------------
// P-256 密钥
// ---------------------------------------------------------------------------

/**
 * 生成一对 P-256 密钥。
 * 返回 { publicKeyRaw（未压缩 65 字节 Buffer）, publicKeyB64, privateJwk }。
 * privateJwk 直接可喂给 crypto.createPrivateKey({ key, format: 'jwk' })。
 */
export function generateP256KeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  // SPKI 的最后一个 BIT STRING 里就是未压缩点（0x04 || X || Y，共 65 字节）。
  // 不靠固定偏移量取值，直接找末尾的 65 字节并校验首字节，避免 DER 长度变化踩坑。
  const raw = spki.subarray(spki.length - 65);
  if (raw[0] !== 0x04) throw new Error('导出的公钥不是未压缩点格式，无法用于 VAPID');
  return { publicKeyRaw: Buffer.from(raw), publicKeyB64: b64url(raw), privateJwk };
}

/** 从 JWK 还原可用于签名的私钥对象。 */
export function privateKeyFromJwk(jwk) {
  return crypto.createPrivateKey({ key: jwk, format: 'jwk' });
}

/** 从 JWK 还原公钥对象。 */
export function publicKeyFromJwk(jwk) {
  return crypto.createPublicKey({ key: jwk, format: 'jwk' });
}

// ---------------------------------------------------------------------------
// VAPID：ES256 JWT
// ---------------------------------------------------------------------------

/**
 * 生成 VAPID 授权头里的那个 JWT。
 *
 * 三个容易踩死的点（都已按 RFC 8292 实现）：
 *  1. 头固定 {"typ":"JWT","alg":"ES256"}。
 *  2. aud 是推送端点 URL 的 origin（scheme://host[:port]），不是整条 URL。
 *  3. 签名必须是 64 字节的 r||s（ieee-p1363）。Node 里只有
 *     crypto.sign(alg, data, keyObject) 这条路径认 dsaEncoding，
 *     crypto.createSign().sign() 会忽略它并吐 DER —— 那是错的，推送端点会 401。
 */
export function vapidJwt(endpoint, privateJwk, subject, { nowMs = Date.now(), ttlSec = 12 * 3600 } = {}) {
  const url = new URL(endpoint);
  if (!subject || !/^(mailto:|https:)/.test(subject)) {
    throw new Error('VAPID subject 必须是 mailto: 或 https: 开头');
  }
  const header = { typ: 'JWT', alg: 'ES256' };
  const payload = {
    aud: url.origin,
    exp: Math.floor(nowMs / 1000) + ttlSec,
    sub: subject,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = privateKeyFromJwk(privateJwk);
  const signature = crypto.sign('sha256', Buffer.from(signingInput, 'utf8'), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  if (signature.length !== 64) {
    throw new Error(`VAPID 签名长度应为 64 字节，实际 ${signature.length}（dsaEncoding 没生效）`);
  }
  return `${signingInput}.${b64url(signature)}`;
}

/** 组装 Authorization 请求头的值。 */
export function vapidAuthHeader(jwt, publicKeyB64) {
  return `vapid t=${jwt}, k=${publicKeyB64}`;
}

// ---------------------------------------------------------------------------
// RFC 8291：aes128gcm 正文加密
// ---------------------------------------------------------------------------

/** HKDF-SHA256，按 RFC 5869。 */
function hkdf(ikm, salt, info, length) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
}

/**
 * 用订阅者的 p256dh / auth 加密一条推送正文。
 *
 * 参数：
 *   payload       要加密的明文字符串（通常是 JSON）
 *   p256dhB64     订阅里的 keys.p256dh（未压缩 65 字节的 base64url）
 *   authB64       订阅里的 keys.auth（16 字节）
 *   options.rs    record size，默认 4096（单条记录够用）
 *
 * 返回完整请求体：salt(16) || rs(4, 大端) || idlen(1)=65 || keyid(65) || GCM 密文。
 * 密文里的明文尾部带 0x02 分隔符（RFC 8188 的最后一条记录）。
 */
export function encryptPayload(payload, p256dhB64, authB64, { rs = 4096, salt } = {}) {
  const message = Buffer.from(payload, 'utf8');
  if (message.length > 3993 || !Number.isInteger(rs) || rs <= message.length + 17) {
    throw new Error('单记录明文最多 3993 字节，rs 必须大于明文加 17 字节');
  }
  const uaPublic = toBuffer(p256dhB64, 'p256dh');
  if (uaPublic.length !== 65 || uaPublic[0] !== 0x04) {
    throw new Error(`p256dh 必须是 65 字节未压缩点，实际 ${uaPublic.length} 字节`);
  }
  const authSecret = toBuffer(authB64, 'auth');
  if (authSecret.length !== 16) {
    throw new Error(`auth 必须是 16 字节，实际 ${authSecret.length} 字节`);
  }

  // 每条消息一个新的临时密钥对
  const as = crypto.createECDH('prime256v1');
  as.generateKeys();
  const asPublic = as.getPublicKey(); // 65 字节未压缩

  const sharedSecret = as.computeSecret(uaPublic);

  // RFC 8291 §3.4：IKM = HKDF(ikm=sharedSecret, salt=authSecret,
  //   info="WebPush: info\0" || ua_public || as_public, 32)
  const ikm = hkdf(
    sharedSecret,
    authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), uaPublic, asPublic]),
    32,
  );

  const useSalt = salt ? Buffer.from(salt) : crypto.randomBytes(16);
  if (useSalt.length !== 16) throw new Error('salt 必须是 16 字节');

  const cek = hkdf(ikm, useSalt, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(ikm, useSalt, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const plaintext = Buffer.concat([message, Buffer.from([0x02])]);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);

  const header = Buffer.alloc(5);
  header.writeUInt32BE(rs, 0);
  header.writeUInt8(asPublic.length, 4);

  return Buffer.concat([useSalt, header, asPublic, ciphertext]);
}

/**
 * 解密函数：只给自测用（tools/selftest.mjs --mode crypto）。
 * 模拟浏览器端，验证我们加密出来的东西确实能被订阅者解开。
 */
export function decryptPayload(body, uaPrivateKey, authB64, { salt, asPublic, ciphertext } = {}) {
  const saltBuf = salt ?? body.subarray(0, 16);
  const headerBuf = body.subarray(16, 21);
  const keyidLen = headerBuf.readUInt8(4);
  const asPub = asPublic ?? body.subarray(21, 21 + keyidLen);
  const ct = ciphertext ?? body.subarray(21 + keyidLen);

  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(uaPrivateKey);
  const sharedSecret = ecdh.computeSecret(Buffer.from(asPub));

  const authSecret = toBuffer(authB64, 'auth');
  const ikm = hkdf(
    sharedSecret,
    authSecret,
    Buffer.concat([Buffer.from('WebPush: info\0', 'utf8'), ecdh.getPublicKey(), Buffer.from(asPub)]),
    32,
  );
  const cek = hkdf(ikm, saltBuf, Buffer.from('Content-Encoding: aes128gcm\0', 'utf8'), 16);
  const nonce = hkdf(ikm, saltBuf, Buffer.from('Content-Encoding: nonce\0', 'utf8'), 12);

  const tag = ct.subarray(ct.length - 16);
  const data = ct.subarray(0, ct.length - 16);
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);

  // 去掉 RFC 8188 的填充：最后一个非 0x00 字节就是分隔符
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0x00) end--;
  if (end < 0 || plain[end] !== 0x02) throw new Error('解出的明文缺少 0x02 分隔符');
  return plain.subarray(0, end).toString('utf8');
}

/** 生成指定字节数的随机 base64url 字符串。 */
export function randomToken(bytes = 32) {
  return b64url(crypto.randomBytes(bytes));
}

/** 定时安全比较，用于令牌校验。 */
export function safeEqual(a, b) {
  const bufA = Buffer.from(String(a ?? ''), 'utf8');
  const bufB = Buffer.from(String(b ?? ''), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
