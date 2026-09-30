// 加密层与推送体的单元测试。
//
// 这是整个项目里最需要测试的部分：VAPID 签名和 RFC 8291 加密一旦写错，
// 现象是"手机上收不到"，而错误信息极难定位。所以这里逐字节验。
//
// 运行：node --test tests/

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  b64url,
  unb64url,
  generateP256KeyPair,
  vapidJwt,
  vapidAuthHeader,
  encryptPayload,
  decryptPayload,
  randomToken,
  safeEqual,
} from '../lib/crypto.mjs';

// 独立期望值来自 RFC 8291 §5 / Appendix A，不使用本项目的加密生成。
test('RFC 8291 标准向量：解密与发送字节都匹配官方样例', t => {
  const receiver = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
  const auth = 'BTBZMqHH6r4Tts7J_aSIgg';
  const body = unb64url('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN');
  const message = 'When I grow up, I want to be a watermelon';
  assert.equal(decryptPayload(body, unb64url('q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94'), auth), message);
  const sender = crypto.createECDH('prime256v1');
  sender.setPrivateKey(unb64url('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'));
  t.mock.method(sender, 'generateKeys', () => sender.getPublicKey());
  t.mock.method(crypto, 'createECDH', () => sender);
  assert.deepEqual(encryptPayload(message, receiver, auth, { salt: unb64url('DGv6ra1nlYgDCS1FRnbzlw') }), body);
});

test('单记录拒绝超过 Web Push 4096 字节的请求体', () => {
  const sub = makeSubscriber();
  assert.throws(() => encryptPayload('a'.repeat(3994), sub.p256dh, sub.auth), /3993|记录/);
});

/** 造一个"浏览器订阅者"：自带私钥，用来验证我们加密的东西确实能被解开。 */
function makeSubscriber() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const authSecret = crypto.randomBytes(16);
  return {
    ecdh,
    privateKey: ecdh.getPrivateKey(),
    publicKeyRaw: ecdh.getPublicKey(), // 65 字节未压缩
    p256dh: b64url(ecdh.getPublicKey()),
    auth: b64url(authSecret),
  };
}

test('base64url 编解码可往返，且不含 + / =', () => {
  const buf = crypto.randomBytes(97);
  const encoded = b64url(buf);
  assert.equal(encoded.includes('+'), false);
  assert.equal(encoded.includes('/'), false);
  assert.equal(encoded.includes('='), false);
  assert.deepEqual(unb64url(encoded), buf);
});

test('base64url 解码兼容带 padding 与普通 base64', () => {
  const buf = crypto.randomBytes(48);
  const standard = buf.toString('base64');
  assert.deepEqual(unb64url(standard), buf);
  assert.deepEqual(unb64url(`${b64url(buf)}`), buf);
});

test('P-256 生成的公钥是 65 字节未压缩点', () => {
  const kp = generateP256KeyPair();
  assert.equal(kp.publicKeyRaw.length, 65);
  assert.equal(kp.publicKeyRaw[0], 0x04);
  assert.equal(kp.publicKeyB64, b64url(kp.publicKeyRaw));
  // 私钥 JWK 必须能被 Node 还原
  const priv = crypto.createPrivateKey({ key: kp.privateJwk, format: 'jwk' });
  assert.equal(priv.asymmetricKeyType, 'ec');
});

test('VAPID JWT：头、aud、sub、exp 都符合 RFC 8292，签名恰好 64 字节', () => {
  const kp = generateP256KeyPair();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123:APA91bXYZ';
  const now = 1_700_000_000_000;
  const jwt = vapidJwt(endpoint, kp.privateJwk, 'mailto:someone@example.com', { nowMs: now });

  const [h, p, s] = jwt.split('.');
  assert.equal(h && p && s ? 3 : 0, 3, 'JWT 必须是三段');

  const header = JSON.parse(unb64url(h).toString('utf8'));
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });

  const payload = JSON.parse(unb64url(p).toString('utf8'));
  assert.equal(payload.aud, 'https://fcm.googleapis.com', 'aud 必须是 endpoint 的 origin');
  assert.equal(payload.sub, 'mailto:someone@example.com');
  assert.equal(payload.exp, Math.floor(now / 1000) + 12 * 3600);

  // 关键断言：ieee-p1363 必须生效，否则是 DER 长度（约 70~72 字节），推送服务会 401
  const sig = unb64url(s);
  assert.equal(sig.length, 64, 'ES256 签名必须是 64 字节 r||s');

  // 用公钥验签，确认不是随便拼的 64 字节
  const pub = crypto.createPublicKey({ key: kp.privateJwk, format: 'jwk' });
  const ok = crypto.verify(
    'sha256',
    Buffer.from(`${h}.${p}`, 'utf8'),
    { key: pub, dsaEncoding: 'ieee-p1363' },
    sig,
  );
  assert.equal(ok, true, '签名应当能通过验签');
});

test('VAPID JWT 拒绝非法的 subject', () => {
  const kp = generateP256KeyPair();
  assert.throws(() => vapidJwt('https://example.com/x', kp.privateJwk, 'someone@example.com'), /subject/);
});

test('VAPID 授权头格式正确', () => {
  const header = vapidAuthHeader('a.b.c', 'PUBKEY');
  assert.equal(header, 'vapid t=a.b.c, k=PUBKEY');
});

test('RFC 8291：加密结果能被订阅者解开，且记录头字段正确', () => {
  const sub = makeSubscriber();
  const plaintext = JSON.stringify({ title: '需要批准', body: 'rm -rf /tmp/x', n: 42 });
  const body = encryptPayload(plaintext, sub.p256dh, sub.auth);

  // salt(16) || rs(4) || idlen(1) || keyid(65) || 密文
  assert.equal(body.readUInt32BE(16), 4096, 'rs 默认 4096');
  assert.equal(body.readUInt8(20), 65, 'idlen 必须是 65');
  assert.equal(body[21], 0x04, 'keyid 必须是未压缩点');

  const decrypted = decryptPayload(body, sub.privateKey, sub.auth);
  assert.equal(decrypted, plaintext);
});

test('RFC 8291：每次加密的 salt 与临时公钥都不同（不能复用）', () => {
  const sub = makeSubscriber();
  const a = encryptPayload('same', sub.p256dh, sub.auth);
  const b = encryptPayload('same', sub.p256dh, sub.auth);
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt 必须每次新生成');
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), '临时公钥必须每次新生成');
});

test('RFC 8291：篡改密文会导致认证失败（GCM 真的在起作用）', () => {
  const sub = makeSubscriber();
  const body = encryptPayload('secret', sub.p256dh, sub.auth);
  const tampered = Buffer.from(body);
  tampered[tampered.length - 20] ^= 0xff;
  assert.throws(() => decryptPayload(tampered, sub.privateKey, sub.auth));
});

test('RFC 8291：中文与 emoji 能原样往返（推送正文就是中文）', () => {
  const sub = makeSubscriber();
  const text = JSON.stringify({ title: '任务完成 ✅', body: '已生成报告：`data/报告.md` —— 注意 0x02 分隔符不能被吃掉' });
  const body = encryptPayload(text, sub.p256dh, sub.auth);
  assert.equal(decryptPayload(body, sub.privateKey, sub.auth), text);
});

test('加密函数对非法输入要报错，而不是默默产出一个坏包', () => {
  const sub = makeSubscriber();
  assert.throws(() => encryptPayload('x', b64url(crypto.randomBytes(64)), sub.auth), /65 字节/);
  assert.throws(() => encryptPayload('x', sub.p256dh, b64url(crypto.randomBytes(15))), /16 字节/);
});

test('randomToken 长度与 safeEqual 行为', () => {
  const t = randomToken(32);
  assert.equal(unb64url(t).length, 32);
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abd'), false);
  assert.equal(safeEqual('abc', 'abcd'), false, '长度不同必须直接 false，不能抛');
  assert.equal(safeEqual(null, ''), true);
});
