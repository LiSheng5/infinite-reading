/*
 * 无限阅读 · sidecar · SQLite（node:sqlite，内置，零依赖）
 *
 * 只做「开库 + 建表 + 迁移 + 预置语句」，不做业务判断。
 * 表结构一次建全（触发器 / 触发记录 / 邮件审计 / 邮件草稿 / 支付授权 / 支付流水），
 * 后续功能按阶段启用，避免反复迁移。
 *
 * 要求 Node ≥ 24（同根 `package.json` 的 engines；node:sqlite 于 22.5 引入、≥ 23.4 无需 --experimental-sqlite）。
 */
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, ensureDataDir } from './config.mjs';
import { TX, TRIGGER, FIRE, DRAFT, AUDIT } from './statuses.mjs';

let _db = null;

// 状态列的取值与默认值唯一口径在 statuses.mjs：SQL 拼接处一律引用那边的常量
const SCHEMA = `
CREATE TABLE IF NOT EXISTS triggers (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,                 -- once | interval | cron
  spec        TEXT NOT NULL,                 -- JSON: {at} | {everyMs} | {expr,tz}
  channel     TEXT NOT NULL DEFAULT '',      -- 注入目标（storyId 或空=新会话）
  prompt      TEXT NOT NULL DEFAULT '',      -- 合成入站消息的模板
  reason      TEXT NOT NULL DEFAULT '',      -- 模型声明的触发原因（给用户看）
  enabled     INTEGER NOT NULL DEFAULT 1,
  status      TEXT NOT NULL DEFAULT '${TRIGGER.PENDING_CONFIRM}',  -- pending_confirm | active | paused
  next_at     INTEGER,
  last_at     INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE(user_id, name)
);

CREATE TABLE IF NOT EXISTS trigger_fires (
  id           TEXT PRIMARY KEY,
  trigger_id   TEXT NOT NULL,
  due_at       INTEGER NOT NULL,
  status       TEXT NOT NULL DEFAULT '${FIRE.PENDING}',   -- pending | delivered | skipped
  reason       TEXT NOT NULL DEFAULT '',
  claimed_at   INTEGER,
  delivered_at INTEGER,
  FOREIGN KEY(trigger_id) REFERENCES triggers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS email_audit (
  id       TEXT PRIMARY KEY,
  at       INTEGER NOT NULL,
  kind     TEXT NOT NULL,                 -- send | draft | confirm
  to_addr  TEXT NOT NULL DEFAULT '',
  subject  TEXT NOT NULL DEFAULT '',
  status   TEXT NOT NULL DEFAULT '${AUDIT.OK}',    -- ok | pending（发送占位） | denied
  code     TEXT NOT NULL DEFAULT '',
  actor    TEXT NOT NULL DEFAULT 'user'   -- user | agent | system
);

CREATE TABLE IF NOT EXISTS email_drafts (
  id      TEXT PRIMARY KEY,
  at      INTEGER NOT NULL,
  to_addr TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body    TEXT NOT NULL DEFAULT '',
  status  TEXT NOT NULL DEFAULT '${DRAFT.PENDING}'  -- pending | sending | sent | discarded
);

CREATE TABLE IF NOT EXISTS payment_mandates (
  id                TEXT PRIMARY KEY,
  agent             TEXT NOT NULL,
  total_limit_cents INTEGER NOT NULL DEFAULT 0,
  currency          TEXT NOT NULL DEFAULT 'CNY',
  categories        TEXT NOT NULL DEFAULT '[]',
  period_start      INTEGER NOT NULL DEFAULT 0,
  period_end        INTEGER NOT NULL DEFAULT 0,
  created_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_transactions (
  id           TEXT PRIMARY KEY,
  intent_id    TEXT NOT NULL UNIQUE,
  agent        TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'CNY',
  merchant     TEXT NOT NULL DEFAULT '',
  category     TEXT NOT NULL DEFAULT '',
  items        TEXT NOT NULL DEFAULT '[]',
  status       TEXT NOT NULL DEFAULT '${TX.PENDING}',  -- pending | approved | charging | awaiting_payment | charged | denied
  code         TEXT NOT NULL DEFAULT '',
  provider_ref TEXT NOT NULL DEFAULT '',          -- 渠道回执号 / 订单号（不含任何支付凭证）
  created_at   INTEGER NOT NULL,
  approved_at  INTEGER,
  charged_at   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_triggers_next   ON triggers(status, enabled, next_at);
CREATE INDEX IF NOT EXISTS idx_fires_trigger   ON trigger_fires(trigger_id, due_at);
CREATE INDEX IF NOT EXISTS idx_fires_status    ON trigger_fires(status, due_at);
CREATE INDEX IF NOT EXISTS idx_email_audit_at  ON email_audit(at);
CREATE INDEX IF NOT EXISTS idx_tx_created      ON payment_transactions(created_at);
`;

// 老库补列（幂等）：SQLite 没有 IF NOT EXISTS 的 ADD COLUMN，只能尝试后忽略错误
function tryAlter(db, sql) { try { db.exec(sql); } catch (_) {} }

/* 在指定文件（或 ':memory:'）上开库并建表 —— 单测用 :memory:，运行用 DB_PATH */
export function openDbAt(file) {
  const db = new DatabaseSync(file);
  try { db.exec('PRAGMA journal_mode = WAL'); } catch (_) {}
  try { db.exec('PRAGMA foreign_keys = ON'); } catch (_) {}
  db.exec(SCHEMA);
  tryAlter(db, "ALTER TABLE payment_transactions ADD COLUMN provider_ref TEXT NOT NULL DEFAULT ''");
  // 支出按授权范围（mandate）关联统计：老库补列，幂等
  tryAlter(db, "ALTER TABLE payment_transactions ADD COLUMN mandate_id TEXT NOT NULL DEFAULT ''");
  return db;
}

export function openDb() {
  if (_db) return _db;
  ensureDataDir();
  _db = openDbAt(DB_PATH);
  return _db;
}

export function closeDb() {
  if (!_db) return;
  try { _db.close(); } catch (_) {}
  _db = null;
}
