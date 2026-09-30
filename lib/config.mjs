// 配置加载与首次生成。
//
// data/config.json 是唯一配置源。首次启动时自动生成：
//   - hookToken / appToken：随机令牌
//   - vapid：P-256 密钥对 + subject
// 并对缺失字段做兜底合并，保证升级时老配置也能跑。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateP256KeyPair, randomToken } from './crypto.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 注意：数据目录必须"每次调用时"计算，不能做成模块级常量。
// 否则测试里切换 AGENT_BRIDGE_DATA 之后，后一个实例还在读写前一个目录的数据
// （现象是"已经配对过"这种跨用例污染，非常难查）。
export function dataDir() {
  return process.env.AGENT_BRIDGE_DATA ? path.resolve(process.env.AGENT_BRIDGE_DATA) : path.join(ROOT, 'data');
}

export function configFile() {
  return path.join(dataDir(), 'config.json');
}

/** @deprecated 用 dataDir() / configFile()。保留是为了不破坏已有的 import。 */
export const DATA_DIR = dataDir();
/** @deprecated 用 configFile()。 */
export const CONFIG_FILE = configFile();

export const DEFAULT_VAPID_SUBJECT = 'mailto:agent-bridge@localhost';

/** 深合并：以 defaults 为底，用 incoming 覆盖存在的键。 */
function merge(defaults, incoming) {
  if (incoming === null || incoming === undefined) return defaults;
  // 类型不一致时（例如配置里写了个字符串但默认是对象）直接采用用户写的值，
  // 不要让 merge 去"猜"——猜错了会抛出很难懂的 in 运算符错误。
  if (Array.isArray(defaults) || Array.isArray(incoming) || typeof defaults !== 'object' || typeof incoming !== 'object') {
    return incoming;
  }
  const out = { ...defaults };
  for (const [k, v] of Object.entries(incoming)) {
    if (k.startsWith('_')) continue; // 下划线开头的是注释字段，不进内存
    out[k] = k in defaults ? merge(defaults[k], v) : v;
  }
  return out;
}

/**
 * 处理 vapid 段：密钥是"整体"覆盖的，不能逐字段深合并
 * （defaults 里 privateJwk 是 null，null 和 JWK 对象合并会得到空对象，把密钥弄丢）。
 */
function mergeVapid(defaults, incoming, generated) {
  const raw = incoming && typeof incoming === 'object' ? incoming : {};
  const onDiskJwk = raw.privateJwk && typeof raw.privateJwk === 'object' ? raw.privateJwk : null;
  const onDiskPub = typeof raw.publicKey === 'string' && raw.publicKey.length > 20 ? raw.publicKey : null;

  if (onDiskJwk && onDiskPub) {
    return {
      publicKey: onDiskPub,
      privateJwk: onDiskJwk,
      subject: typeof raw.subject === 'string' && raw.subject ? raw.subject : defaults.subject,
    };
  }

  // 磁盘上没有可用密钥（首次运行 / 文件被改坏）：生成一对新的
  const kp = generateP256KeyPair();
  generated.push('vapid');
  return {
    publicKey: kp.publicKeyB64,
    privateJwk: kp.privateJwk,
    subject: typeof raw.subject === 'string' && raw.subject ? raw.subject : defaults.subject,
  };
}

export function defaultConfig() {
  return {
    enabled: true,
    port: 4571,
    host: '127.0.0.1',
    hookToken: null,
    appToken: null,
    pairedAt: null,
    pairCodeIssuedAt: null,
    vapid: {
      publicKey: null,
      privateJwk: null,
      subject: DEFAULT_VAPID_SUBJECT,
    },
    push: {
      decisionWaitMs: 90_000,
      decisionWaitMaxMs: 240_000,
      perTurnDedup: true,
      markdownStrip: true,
    },
    notify: {
      replyCompleted: true, // 当前手机选中聊天的回复完成提醒
      success: 'silent', // silent | push | batch
      contentMode: 'summary', // summary | none
      summaryMaxChars: 140,
      batchWindowMs: 60_000,
    },
    notifyWrapper: {
      original: [],
      url: 'http://127.0.0.1:4571/api/notify',
    },
    appServer: {
      enabled: false,
      listen: 'ws://127.0.0.1:4517',
      token: '',
    },
  };
}

/**
 * 载入配置；缺失的关键字段就地生成并落盘。
 * @returns {{config: object, created: boolean, generated: string[]}}
 */
export function loadConfig({ force = false } = {}) {
  const dir = dataDir();
  const file = configFile();
  fs.mkdirSync(dir, { recursive: true });
  const existed = fs.existsSync(file);
  let onDisk = {};
  if (existed) {
    try {
      onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(`${file} 不是合法 JSON：${err.message}`);
    }
  }

  const defaults = defaultConfig();
  // vapid 段不参与通用深合并：默认值里 privateJwk 是 null，
  // 而 null 与磁盘上的 JWK 对象深合并会得到 {}（把密钥弄丢）。
  // 它由 mergeVapid 单独处理：要么整体沿用磁盘上的密钥，要么整体重建。
  const { vapid: _ignoredVapid, ...restOnDisk } = onDisk && typeof onDisk === 'object' ? onDisk : {};
  const config = merge(defaults, restOnDisk);
  const generated = [];
  config.vapid = mergeVapid(defaults.vapid, onDisk.vapid, generated);

  if (!config.hookToken) {
    config.hookToken = randomToken(32);
    generated.push('hookToken');
  }
  if (!config.appToken) {
    config.appToken = randomToken(32);
    generated.push('appToken');
  }
  if (!config.vapid.subject || !/^(mailto:|https:)/.test(config.vapid.subject)) {
    config.vapid.subject = DEFAULT_VAPID_SUBJECT;
    generated.push('vapid.subject(默认值)');
  }

  const pending = generated.length > 0 || !existed || force;
  if (pending) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
  }

  return { config, created: !existed, generated };
}

/** 保存配置（例如手机配对成功后写 pairedAt）。 */
export function saveConfig(config) {
  const dir = dataDir();
  const file = configFile();
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 有效的等待上限：受 decisionWaitMaxMs 硬夹紧。 */
export function effectiveWaitMs(config, requested) {
  const max = Math.max(1000, Number(config.push?.decisionWaitMaxMs) || 240_000);
  const wanted = Number(requested) || Number(config.push?.decisionWaitMs) || 90_000;
  return Math.min(Math.max(1000, wanted), max);
}
