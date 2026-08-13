import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type { Protocol, LlmRow, LlmInput, LogRow } from "./types";

// SQLite 数据文件存放在项目根目录的 data/ 下
// 通过环境变量 DATA_DIR 可覆盖（方便部署）
const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(process.cwd(), "data");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const DB_PATH = path.join(DATA_DIR, "relay.db");

// 单例：避免 Next.js dev 热更新时重复打开连接
const globalForDb = globalThis as unknown as {
  __db?: Database.Database;
};

const SCHEMA_VERSION = 3;

function createDb(): Database.Database {
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // 跨进程写锁等待 5s，避免构建期多 worker 并发初始化时报 SQLITE_BUSY
  db.pragma("busy_timeout = 5000");
  ensureSchema(db);
  return db;
}

/**
 * schema 版本管理：开发期 schema 变更时直接重建。
 * 全程幂等，可被多个构建 worker / dev 热更新安全并发调用。
 * 旧库（版本不符或缺版本表）会被整体 drop 后重建 —— 仅适合开发/个人使用。
 *
 * 多进程并发时：busy_timeout 让 SQLite 自动等待写锁；
 * IMMEDIATE 事务串行化初始化。
 */
function ensureSchema(db: Database.Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS __schema (version INTEGER NOT NULL);`);

  const txn = db.transaction(() => {
    const row = db.prepare("SELECT version FROM __schema").get() as
      | { version: number }
      | undefined;

    if (!row) {
      db.exec(`DROP TABLE IF EXISTS logs; DROP TABLE IF EXISTS llms;`);
      createTables(db);
      db.prepare("INSERT INTO __schema (version) VALUES (?)").run(
        SCHEMA_VERSION
      );
    } else if (row.version !== SCHEMA_VERSION) {
      db.exec(`DROP TABLE IF EXISTS logs; DROP TABLE IF EXISTS llms;`);
      createTables(db);
      db.prepare("UPDATE __schema SET version = ?").run(SCHEMA_VERSION);
    }
  });
  txn.immediate();
}

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llms (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      alias             TEXT NOT NULL UNIQUE,
      openai_base_url   TEXT,
      anthropic_base_url TEXT,
      token             TEXT NOT NULL,
      model_name        TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      CHECK (
        (openai_base_url IS NOT NULL AND openai_base_url <> '')
        OR (anthropic_base_url IS NOT NULL AND anthropic_base_url <> '')
      )
    );

    CREATE TABLE IF NOT EXISTS logs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      llm_id       INTEGER,
      llm_alias    TEXT NOT NULL,
      protocol     TEXT NOT NULL,
      base_url     TEXT NOT NULL,
      endpoint     TEXT NOT NULL,
      model_name   TEXT,
      input        TEXT,
      output       TEXT,
      status       TEXT NOT NULL,
      error        TEXT,
      duration_ms  INTEGER NOT NULL,
      status_code  INTEGER,
      created_at   TEXT NOT NULL,
      FOREIGN KEY (llm_id) REFERENCES llms(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_llm_id ON logs(llm_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
  `);
}

export const db: Database.Database = globalForDb.__db ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__db = db;
}

// ---- LLM CRUD ----
const now = () => new Date().toISOString();

export function listLlms(): LlmRow[] {
  return db.prepare("SELECT * FROM llms ORDER BY id ASC").all() as LlmRow[];
}

export function getLlm(id: number): LlmRow | undefined {
  return db.prepare("SELECT * FROM llms WHERE id = ?").get(id) as
    | LlmRow
    | undefined;
}

/** 按别名查找 LLM（别名 = 对外的 model 名） */
export function getLlmByAlias(alias: string): LlmRow | undefined {
  return db
    .prepare("SELECT * FROM llms WHERE alias = ? AND enabled = 1")
    .get(alias) as LlmRow | undefined;
}

function normalizeUrl(u?: string | null): string | null {
  if (u === undefined || u === null) return null;
  const trimmed = u.trim();
  return trimmed === "" ? null : trimmed;
}

export function createLlm(input: LlmInput): LlmRow {
  const ts = now();
  db.prepare(
    `INSERT INTO llms
       (name, alias, openai_base_url, anthropic_base_url, token, model_name, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.name,
    input.alias,
    normalizeUrl(input.openai_base_url),
    normalizeUrl(input.anthropic_base_url),
    input.token,
    input.model_name,
    input.enabled === false ? 0 : 1,
    ts,
    ts
  );
  const id = (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
  return getLlm(id)!;
}

export function updateLlm(
  id: number,
  input: LlmInput
): LlmRow | undefined {
  const existing = getLlm(id);
  if (!existing) return undefined;
  db.prepare(
    `UPDATE llms
     SET name = ?, alias = ?, openai_base_url = ?, anthropic_base_url = ?, token = ?, model_name = ?, enabled = ?, updated_at = ?
     WHERE id = ?`
  ).run(
    input.name,
    input.alias,
    normalizeUrl(input.openai_base_url),
    normalizeUrl(input.anthropic_base_url),
    input.token,
    input.model_name,
    input.enabled === false ? 0 : 1,
    now(),
    id
  );
  return getLlm(id);
}

export function deleteLlm(id: number): boolean {
  const info = db.prepare("DELETE FROM llms WHERE id = ?").run(id);
  return info.changes > 0;
}

// ---- Logs 操作 ----
export interface LogInsert {
  llm_id: number | null;
  llm_alias: string;
  protocol: Protocol;
  base_url: string;
  endpoint: string;
  model_name: string | null;
  input: string | null;
  output: string | null;
  status: "success" | "failed" | "streaming";
  error: string | null;
  duration_ms: number;
  status_code: number | null;
}

export function insertLog(log: LogInsert): number {
  db.prepare(
    `INSERT INTO logs
       (llm_id, llm_alias, protocol, base_url, endpoint, model_name, input, output, status, error, duration_ms, status_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    log.llm_id,
    log.llm_alias,
    log.protocol,
    log.base_url,
    log.endpoint,
    log.model_name,
    log.input,
    log.output,
    log.status,
    log.error,
    log.duration_ms,
    log.status_code,
    now()
  );
  return (
    db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }
  ).id;
}

export function updateLog(
  id: number,
  patch: Partial<
    Pick<LogRow, "output" | "status" | "error" | "duration_ms" | "status_code">
  >
) {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  if (patch.output !== undefined) {
    sets.push("output = ?");
    values.push(patch.output);
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.duration_ms !== undefined) {
    sets.push("duration_ms = ?");
    values.push(patch.duration_ms);
  }
  if (patch.status_code !== undefined) {
    sets.push("status_code = ?");
    values.push(patch.status_code);
  }
  if (sets.length === 0) return;
  values.push(id);
  db.prepare(`UPDATE logs SET ${sets.join(", ")} WHERE id = ?`).run(...values);
}

export function listLogs(opts: {
  llmId?: number;
  status?: string;
  limit?: number;
  offset?: number;
}): { rows: LogRow[]; total: number } {
  const limit = opts.limit ?? 50;
  const offset = opts.offset ?? 0;
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.llmId !== undefined) {
    where.push("llm_id = ?");
    params.push(opts.llmId);
  }
  if (opts.status) {
    where.push("status = ?");
    params.push(opts.status);
  }
  const whereSql =
    where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const rows = db
    .prepare(
      `SELECT * FROM logs ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...params, limit, offset) as LogRow[];
  const total = (
    db.prepare(`SELECT COUNT(*) AS c FROM logs ${whereSql}`).get(...params) as {
      c: number;
    }
  ).c;
  return { rows, total };
}

export function getLog(id: number): LogRow | undefined {
  return db.prepare("SELECT * FROM logs WHERE id = ?").get(id) as
    | LogRow
    | undefined;
}
