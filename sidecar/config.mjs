/*
 * 无限阅读 · 本地旁路服务（sidecar）· 配置层
 *
 * 为什么单独一层：白名单 / 额度 / 每日上限 / 免打扰时段 / token 这类**安全项**
 * 只存在这里（sidecar/data/config.json），是整个应用里它们唯一的真源。
 * 前端设置页只是它的「编辑界面」（经 HTTP API 读写），前端本地不保存这些值，
 * 模型更没有任何写入通道（见 ARCHITECTURE.md / SECURITY.md）。
 * 这与 SillyTavern（config.yaml + secrets.json）、Open WebUI（环境变量 + Admin Panel）、
 * LibreChat（.env > librechat.yaml > 面板）三家做法一致：安全项真源在服务端。
 *
 * 零依赖：只用 node:fs / node:path / node:crypto。
 * 保守默认：三功能全关、额度 0、白名单空 —— 用户手动开启并填好额度才可能生效。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* 测试 / 多实例场景可用环境变量把数据目录与端口挪开，默认仍是 sidecar/data + 4319 */
function envPort() {
  const n = Math.floor(Number(process.env.IR_SIDECAR_PORT));
  return (Number.isFinite(n) && n > 0 && n < 65536) ? n : 0;
}

export const DATA_DIR = process.env.IR_SIDECAR_DATA_DIR
  ? path.resolve(process.env.IR_SIDECAR_DATA_DIR)
  : path.join(HERE, 'data');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const DB_PATH = path.join(DATA_DIR, 'ir-sidecar.db');
export const LOCK_PATH = path.join(DATA_DIR, '.lock');
export const DEFAULT_PORT = envPort() || 4319;

export const MISSED_POLICIES = ['SKIP', 'RUN_ONCE', 'RUN_ALL'];
export const EMAIL_PROVIDERS = ['mock', 'resend'];
export const PAYMENT_PROVIDERS = ['mock', 'manual-order'];

/* ---------------- 归一化小工具（把任何脏输入夹回安全范围） ---------------- */

function intOrZero(v) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}
function strArray(v, max) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v.slice(0, max || 500)) {
    const s = String(it == null ? '' : it).trim();
    if (s) out.push(s.slice(0, 200));
  }
  return out;
}
function hhmm(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v)) ? String(v) : null;
}
function quietHours(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const it of v.slice(0, 24)) {
    const start = hhmm(it && it.start);
    const end = hhmm(it && it.end);
    if (start && end) out.push({ start, end });
  }
  return out;
}
function enumOf(v, allowed, fallback) {
  return allowed.indexOf(String(v)) >= 0 ? String(v) : fallback;
}
function boolOf(v, fallback) {
  if (v === undefined || v === null) return fallback;
  return !!v;
}

/* ---------------- 默认配置 ---------------- */

export function defaultConfig(port) {
  return {
    token: crypto.randomBytes(32).toString('hex'),
    port: intOrZero(port) || envPort() || DEFAULT_PORT,
    email: { enabled: false, provider: 'mock', allowlist: [], dailyLimit: 0, from: '', resendApiKey: '' },
    schedule: { enabled: false, paused: true, quietHours: [], dailyCap: 0, missedPolicy: 'SKIP' },
    payment: {
      enabled: false, provider: 'mock', currency: 'CNY',
      perTx: 0, daily: 0, monthly: 0, autoApprove: 0, cooldownMin: 0,
      merchantAllowlist: [], merchantBlocklist: [],
      categoryAllowlist: [], categoryBlocklist: [],
      budgets: {},
    },
  };
}

/* 把任意输入夹成一份合法配置；base 只用于补 token / port 这类不可缺省项 */
export function sanitizeConfig(raw, base) {
  const def = base || defaultConfig();
  raw = (raw && typeof raw === 'object') ? raw : {};
  const rEmail = (raw.email && typeof raw.email === 'object') ? raw.email : {};
  const rSched = (raw.schedule && typeof raw.schedule === 'object') ? raw.schedule : {};
  const rPay = (raw.payment && typeof raw.payment === 'object') ? raw.payment : {};

  const token = (typeof raw.token === 'string' && /^[0-9a-f]{32,}$/i.test(raw.token))
    ? raw.token
    : def.token;

  const budgets = {};
  if (rPay.budgets && typeof rPay.budgets === 'object') {
    for (const k of Object.keys(rPay.budgets).slice(0, 50)) {
      budgets[String(k).slice(0, 64)] = intOrZero(rPay.budgets[k]);
    }
  }

  return {
    token,
    port: intOrZero(raw.port) || def.port,
    email: {
      enabled: boolOf(rEmail.enabled, false),
      provider: enumOf(rEmail.provider, EMAIL_PROVIDERS, 'mock'),
      allowlist: strArray(rEmail.allowlist),
      dailyLimit: intOrZero(rEmail.dailyLimit),
      from: String(rEmail.from || '').trim().slice(0, 200),
      resendApiKey: String(rEmail.resendApiKey || '').trim().slice(0, 400),
    },
    schedule: {
      enabled: boolOf(rSched.enabled, false),
      paused: boolOf(rSched.paused, true),   // 默认「暂停」：没开就是暂停
      quietHours: quietHours(rSched.quietHours),
      dailyCap: intOrZero(rSched.dailyCap),
      missedPolicy: enumOf(rSched.missedPolicy, MISSED_POLICIES, 'SKIP'),
    },
    payment: {
      enabled: boolOf(rPay.enabled, false),
      provider: enumOf(rPay.provider, PAYMENT_PROVIDERS, 'mock'),
      currency: (String(rPay.currency || 'CNY').trim().slice(0, 8).toUpperCase() || 'CNY'),
      perTx: intOrZero(rPay.perTx),
      daily: intOrZero(rPay.daily),
      monthly: intOrZero(rPay.monthly),
      autoApprove: intOrZero(rPay.autoApprove),
      cooldownMin: intOrZero(rPay.cooldownMin),
      merchantAllowlist: strArray(rPay.merchantAllowlist),
      merchantBlocklist: strArray(rPay.merchantBlocklist),
      categoryAllowlist: strArray(rPay.categoryAllowlist),
      categoryBlocklist: strArray(rPay.categoryBlocklist),
      budgets,
    },
  };
}

/* ---------------- 文件读写（原子写 + 权限 600） ---------------- */

export function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function writeConfigFile(cfg) {
  ensureDataDir();
  const tmp = CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG_PATH);
}

/* 读配置；文件不存在则用保守默认创建。每次调用都重读，便于用户手改文件后无需重启 */
export function loadConfig() {
  ensureDataDir();
  if (!fs.existsSync(CONFIG_PATH)) {
    const cfg = defaultConfig();
    writeConfigFile(cfg);
    return cfg;
  }
  let raw = null;
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (_) {
    // 配置损坏：先备份现场（不覆盖证据），再用保守默认重建
    try { fs.copyFileSync(CONFIG_PATH, CONFIG_PATH + '.broken.' + Date.now()); } catch (_) {}
    const cfg = defaultConfig();
    writeConfigFile(cfg);
    return cfg;
  }
  const cfg = sanitizeConfig(raw);
  // 归一化落盘（幂等）：用户手改出的脏字段会被夹回安全值
  if (JSON.stringify(raw) !== JSON.stringify(cfg)) writeConfigFile(cfg);
  return cfg;
}

function mergeDeep(base, patch) {
  const out = Object.assign({}, base);
  for (const k of Object.keys(patch || {})) {
    const pv = patch[k];
    const bv = base ? base[k] : undefined;
    if (pv && typeof pv === 'object' && !Array.isArray(pv)
      && bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = Object.assign({}, bv, pv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/* 整体保存（内部用：会保留 token / port） */
export function saveConfig(patch) {
  const cur = loadConfig();
  const next = sanitizeConfig(mergeDeep(cur, patch), cur);
  writeConfigFile(next);
  return next;
}

/*
 * 前端可改的部分：只有三个功能分区。
 * token 与 port 不可经 API 修改（token 只能改文件 / --show-token 查看；port 只能改文件）。
 */
export function applyEditablePatch(patch) {
  const p = (patch && typeof patch === 'object') ? patch : {};
  const safe = {};
  for (const k of ['email', 'schedule', 'payment']) {
    if (p[k] && typeof p[k] === 'object' && !Array.isArray(p[k])) safe[k] = p[k];
  }
  return saveConfig(safe);
}

/* 给前端的只读视图：绝不返回 token；邮件密钥只回布尔 */
export function publicConfig(cfg) {
  const c = cfg || loadConfig();
  return {
    port: c.port,
    email: {
      enabled: c.email.enabled,
      provider: c.email.provider,
      allowlist: c.email.allowlist.slice(),
      dailyLimit: c.email.dailyLimit,
      from: c.email.from,
      hasResendApiKey: !!c.email.resendApiKey,
    },
    schedule: {
      enabled: c.schedule.enabled,
      paused: c.schedule.paused,
      quietHours: c.schedule.quietHours.map(h => ({ start: h.start, end: h.end })),
      dailyCap: c.schedule.dailyCap,
      missedPolicy: c.schedule.missedPolicy,
    },
    payment: {
      enabled: c.payment.enabled,
      provider: c.payment.provider,
      currency: c.payment.currency,
      perTx: c.payment.perTx,
      daily: c.payment.daily,
      monthly: c.payment.monthly,
      autoApprove: c.payment.autoApprove,
      cooldownMin: c.payment.cooldownMin,
      merchantAllowlist: c.payment.merchantAllowlist.slice(),
      merchantBlocklist: c.payment.merchantBlocklist.slice(),
      categoryAllowlist: c.payment.categoryAllowlist.slice(),
      categoryBlocklist: c.payment.categoryBlocklist.slice(),
      budgets: Object.assign({}, c.payment.budgets),
    },
  };
}
