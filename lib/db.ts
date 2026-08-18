import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import type {
  DashboardStats,
  ModelStats24h,
  Protocol,
  LlmRow,
  LlmInput,
  LogRow,
} from "./types";

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

const SCHEMA_VERSION = 10;

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
 * 缺版本记录的旧库会被整体 drop 后重建 —— 仅适合开发/个人使用。
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
      db.exec(`
        DROP TABLE IF EXISTS request_stats;
        DROP TABLE IF EXISTS logs;
        DROP TABLE IF EXISTS llms;
      `);
      createTables(db);
      db.prepare("INSERT INTO __schema (version) VALUES (?)").run(
        SCHEMA_VERSION
      );
    } else if (row.version < SCHEMA_VERSION) {
      migrateSchema(db, row.version);
      db.prepare("UPDATE __schema SET version = ?").run(SCHEMA_VERSION);
    } else if (row.version > SCHEMA_VERSION) {
      throw new Error(
        `数据库 schema 版本 ${row.version} 高于应用支持的 ${SCHEMA_VERSION}`
      );
    }

    // 兼容升级切换窗口：旧进程可能在表迁移完成后、服务重启前继续写入 logs。
    // 每次启动补齐缺失事件，之后新请求由 insertLog 原子双写。
    db.exec(`
      INSERT OR IGNORE INTO request_stats
        (request_id, llm_id, llm_alias, status, duration_ms,
         input_tokens, output_tokens, total_tokens, first_byte_ms, created_at)
      SELECT id, llm_id, llm_alias, status, duration_ms,
        input_tokens, output_tokens, total_tokens, first_byte_ms, created_at
      FROM logs;

      UPDATE request_stats AS s
      SET status = l.status,
        duration_ms = l.duration_ms,
        input_tokens = l.input_tokens,
        output_tokens = l.output_tokens,
        total_tokens = l.total_tokens,
        first_byte_ms = l.first_byte_ms
      FROM logs AS l
      WHERE l.id = s.request_id
        AND s.status = 'streaming'
        AND l.status IN ('success', 'failed');
    `);
  });
  txn.immediate();
}

function migrateSchema(db: Database.Database, fromVersion: number) {
  if (fromVersion < 4) {
    const columns = new Set(
      (
        db.prepare("PRAGMA table_info(logs)").all() as Array<{ name: string }>
      ).map((column) => column.name)
    );
    if (!columns.has("parsed_input"))
      db.exec("ALTER TABLE logs ADD COLUMN parsed_input TEXT");
    if (!columns.has("parsed_output"))
      db.exec("ALTER TABLE logs ADD COLUMN parsed_output TEXT");
    if (!columns.has("parsed_at"))
      db.exec("ALTER TABLE logs ADD COLUMN parsed_at TEXT");
    if (!columns.has("parser_version"))
      db.exec("ALTER TABLE logs ADD COLUMN parser_version INTEGER");
  }
  if (fromVersion < 5) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(llms)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!columns.has("openai_supported"))
      db.exec("ALTER TABLE llms ADD COLUMN openai_supported INTEGER");
    if (!columns.has("anthropic_supported"))
      db.exec("ALTER TABLE llms ADD COLUMN anthropic_supported INTEGER");
    if (!columns.has("protocols_tested_at"))
      db.exec("ALTER TABLE llms ADD COLUMN protocols_tested_at TEXT");
  }
  if (fromVersion < 6) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(llms)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!columns.has("openai_responses_supported"))
      db.exec("ALTER TABLE llms ADD COLUMN openai_responses_supported INTEGER");
  }
  if (fromVersion < 7) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(logs)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!columns.has("is_stream"))
      db.exec("ALTER TABLE logs ADD COLUMN is_stream INTEGER");
  }
  if (fromVersion < 8) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(llms)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!columns.has("url_mode")) {
      db.exec(
        "ALTER TABLE llms ADD COLUMN url_mode TEXT NOT NULL DEFAULT 'unified'"
      );
      db.exec(`UPDATE llms
        SET url_mode = CASE
          WHEN COALESCE(openai_base_url, '') = COALESCE(anthropic_base_url, '')
            THEN 'unified'
          ELSE 'separate'
        END`);
    }
  }
  if (fromVersion < 9) {
    const columns = new Set(
      (db.prepare("PRAGMA table_info(logs)").all() as Array<{ name: string }>).map(
        (column) => column.name
      )
    );
    if (!columns.has("input_tokens"))
      db.exec("ALTER TABLE logs ADD COLUMN input_tokens INTEGER");
    if (!columns.has("output_tokens"))
      db.exec("ALTER TABLE logs ADD COLUMN output_tokens INTEGER");
    if (!columns.has("total_tokens"))
      db.exec("ALTER TABLE logs ADD COLUMN total_tokens INTEGER");
    if (!columns.has("first_byte_ms"))
      db.exec("ALTER TABLE logs ADD COLUMN first_byte_ms INTEGER");
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_logs_stats ON logs(llm_id, created_at DESC)"
    );
  }
  if (fromVersion < 10) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS request_stats (
        request_id    INTEGER PRIMARY KEY,
        llm_id        INTEGER,
        llm_alias     TEXT NOT NULL,
        status        TEXT NOT NULL,
        duration_ms   INTEGER NOT NULL DEFAULT 0,
        input_tokens  INTEGER,
        output_tokens INTEGER,
        total_tokens  INTEGER,
        first_byte_ms INTEGER,
        created_at    TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_request_stats_created
        ON request_stats(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_request_stats_llm_created
        ON request_stats(llm_id, created_at DESC);

      INSERT OR IGNORE INTO request_stats
        (request_id, llm_id, llm_alias, status, duration_ms,
         input_tokens, output_tokens, total_tokens, first_byte_ms, created_at)
      SELECT id, llm_id, llm_alias, status, duration_ms,
        input_tokens, output_tokens, total_tokens, first_byte_ms, created_at
      FROM logs;
    `);
  }
}

function createTables(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS llms (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      name              TEXT NOT NULL,
      alias             TEXT NOT NULL UNIQUE,
      url_mode          TEXT NOT NULL DEFAULT 'unified',
      openai_base_url   TEXT,
      anthropic_base_url TEXT,
      token             TEXT NOT NULL,
      model_name        TEXT NOT NULL,
      enabled           INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      openai_supported INTEGER,
      anthropic_supported INTEGER,
      openai_responses_supported INTEGER,
      protocols_tested_at TEXT,
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
      is_stream    INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      first_byte_ms INTEGER,
      created_at   TEXT NOT NULL,
      parsed_input TEXT,
      parsed_output TEXT,
      parsed_at    TEXT,
      parser_version INTEGER,
      FOREIGN KEY (llm_id) REFERENCES llms(id) ON DELETE SET NULL
    );

    -- 轻量统计事件与日志明细解耦。删除 logs 只释放请求/响应正文，
    -- request_stats 继续保留看板所需的计数、Token 与耗时数据。
    CREATE TABLE IF NOT EXISTS request_stats (
      request_id    INTEGER PRIMARY KEY,
      llm_id        INTEGER,
      llm_alias     TEXT NOT NULL,
      status        TEXT NOT NULL,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      input_tokens  INTEGER,
      output_tokens INTEGER,
      total_tokens  INTEGER,
      first_byte_ms INTEGER,
      created_at    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_logs_llm_id ON logs(llm_id);
    CREATE INDEX IF NOT EXISTS idx_logs_created ON logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_logs_status ON logs(status);
    CREATE INDEX IF NOT EXISTS idx_logs_stats ON logs(llm_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_stats_created ON request_stats(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_request_stats_llm_created ON request_stats(llm_id, created_at DESC);
  `);
}

export const db: Database.Database = globalForDb.__db ?? createDb();

if (process.env.NODE_ENV !== "production") {
  globalForDb.__db = db;
}

// ---- LLM CRUD ----
const now = () => new Date().toISOString();

export function listLlms(): LlmRow[] {
	return db.prepare(`${llmSelect} ORDER BY id ASC`).all() as LlmRow[];
}

export function getLlm(id: number): LlmRow | undefined {
	return db.prepare(`${llmSelect} WHERE id = ?`).get(id) as
    | LlmRow
    | undefined;
}

/** 按别名查找 LLM（别名 = 对外的 model 名） */
export function getLlmByAlias(alias: string): LlmRow | undefined {
	return db
		.prepare(`${llmSelect} WHERE alias = ? AND enabled = 1`)
    .get(alias) as LlmRow | undefined;
}

const llmSelect = `SELECT id, name, alias,
  CASE WHEN url_mode = 'separate' THEN 'separate' ELSE 'unified' END AS url_mode,
  COALESCE(NULLIF(openai_base_url, ''), NULLIF(anthropic_base_url, ''), '') AS base_url,
  COALESCE(openai_base_url, '') AS openai_base_url,
  COALESCE(anthropic_base_url, '') AS anthropic_base_url,
  token, model_name, enabled, created_at, updated_at,
  openai_supported, anthropic_supported, openai_responses_supported, protocols_tested_at
  FROM llms`;

function normalizeUrl(u?: string | null): string | null {
  if (u === undefined || u === null) return null;
  const trimmed = u.trim();
  return trimmed === "" ? null : trimmed;
}

function urlsFromInput(input: LlmInput): {
  mode: "unified" | "separate";
  openai: string | null;
  anthropic: string | null;
} {
  const mode = input.url_mode === "separate" ? "separate" : "unified";
  if (mode === "separate") {
    return {
      mode,
      openai: normalizeUrl(input.openai_base_url),
      anthropic: normalizeUrl(input.anthropic_base_url),
    };
  }
  const unified = normalizeUrl(
    input.base_url ?? input.openai_base_url ?? input.anthropic_base_url
  );
  return { mode, openai: unified, anthropic: unified };
}

export function createLlm(input: LlmInput): LlmRow {
  const ts = now();
  const urls = urlsFromInput(input);
  db.prepare(
    `INSERT INTO llms
       (name, alias, url_mode, openai_base_url, anthropic_base_url, token, model_name, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.name,
    input.alias,
    urls.mode,
    urls.openai,
    urls.anthropic,
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
	const urls = urlsFromInput(input);
	const endpointChanged = urls.mode !== existing.url_mode ||
		urls.openai !== existing.openai_base_url ||
		urls.anthropic !== existing.anthropic_base_url ||
		input.token !== existing.token || input.model_name !== existing.model_name;
	db.prepare(
		`UPDATE llms
	 SET name = ?, alias = ?, url_mode = ?, openai_base_url = ?, anthropic_base_url = ?, token = ?, model_name = ?, enabled = ?, updated_at = ?,
	     openai_supported = ?, anthropic_supported = ?, openai_responses_supported = ?, protocols_tested_at = ?
	 WHERE id = ?`
	).run(
    input.name,
    input.alias,
    urls.mode,
    urls.openai,
    urls.anthropic,
    input.token,
    input.model_name,
    input.enabled === false ? 0 : 1,
		now(),
		endpointChanged ? null : existing.openai_supported,
		endpointChanged ? null : existing.anthropic_supported,
		endpointChanged ? null : existing.openai_responses_supported,
		endpointChanged ? null : existing.protocols_tested_at,
		id
  );
  return getLlm(id);
}

export function updateProtocolSupport(
	id: number, openaiSupported: boolean, anthropicSupported: boolean, responsesSupported: boolean, testedAt: string
): void {
	db.prepare(`UPDATE llms SET openai_supported = ?, anthropic_supported = ?, openai_responses_supported = ?,
	  protocols_tested_at = ? WHERE id = ?`).run(
		openaiSupported ? 1 : 0,
		anthropicSupported ? 1 : 0,
		responsesSupported ? 1 : 0,
		testedAt,
		id,
	);
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
  const createdAt = now();
  return db.transaction(() => {
    const info = db.prepare(
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
      createdAt
    );
    const id = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO request_stats
         (request_id, llm_id, llm_alias, status, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(id, log.llm_id, log.llm_alias, log.status, log.duration_ms, createdAt);
    return id;
  })();
}

export function updateLog(
  id: number,
  patch: Partial<
    Pick<
      LogRow,
      | "output"
      | "status"
      | "error"
      | "duration_ms"
      | "status_code"
      | "is_stream"
      | "input_tokens"
      | "output_tokens"
      | "total_tokens"
      | "first_byte_ms"
    >
  >
) {
  const sets: string[] = [];
  const values: (string | number | null)[] = [];
  const statsSets: string[] = [];
  const statsValues: (string | number | null)[] = [];
  if (patch.output !== undefined) {
    sets.push("output = ?");
    values.push(patch.output);
    sets.push("parsed_output = NULL");
    sets.push("parsed_at = NULL");
    sets.push("parser_version = NULL");
  }
  if (patch.status !== undefined) {
    sets.push("status = ?");
    values.push(patch.status);
    statsSets.push("status = ?");
    statsValues.push(patch.status);
  }
  if (patch.error !== undefined) {
    sets.push("error = ?");
    values.push(patch.error);
  }
  if (patch.duration_ms !== undefined) {
    sets.push("duration_ms = ?");
    values.push(patch.duration_ms);
    statsSets.push("duration_ms = ?");
    statsValues.push(patch.duration_ms);
  }
  if (patch.status_code !== undefined) {
    sets.push("status_code = ?");
    values.push(patch.status_code);
  }
  if (patch.is_stream !== undefined) {
    sets.push("is_stream = ?");
    values.push(patch.is_stream);
  }
  if (patch.input_tokens !== undefined) {
    sets.push("input_tokens = ?");
    values.push(patch.input_tokens);
    statsSets.push("input_tokens = ?");
    statsValues.push(patch.input_tokens);
  }
  if (patch.output_tokens !== undefined) {
    sets.push("output_tokens = ?");
    values.push(patch.output_tokens);
    statsSets.push("output_tokens = ?");
    statsValues.push(patch.output_tokens);
  }
  if (patch.total_tokens !== undefined) {
    sets.push("total_tokens = ?");
    values.push(patch.total_tokens);
    statsSets.push("total_tokens = ?");
    statsValues.push(patch.total_tokens);
  }
  if (patch.first_byte_ms !== undefined) {
    sets.push("first_byte_ms = ?");
    values.push(patch.first_byte_ms);
    statsSets.push("first_byte_ms = ?");
    statsValues.push(patch.first_byte_ms);
  }
  if (sets.length === 0) return;
  db.transaction(() => {
    db.prepare(`UPDATE logs SET ${sets.join(", ")} WHERE id = ?`).run(...values, id);
    if (statsSets.length > 0) {
      db.prepare(`UPDATE request_stats SET ${statsSets.join(", ")} WHERE request_id = ?`)
        .run(...statsValues, id);
    }
  })();
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

export function deleteLogs(opts: {
  llmId?: number;
  status?: string;
}): number {
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
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return db.prepare(`DELETE FROM logs ${whereSql}`).run(...params).changes;
}

export function getLog(id: number): LogRow | undefined {
  return db.prepare("SELECT * FROM logs WHERE id = ?").get(id) as
    | LogRow
    | undefined;
}

export function cacheParsedLog(
  id: number,
  parserVersion: number,
  parsedInput: string,
  parsedOutput: string
): LogRow | undefined {
  db.prepare(
    `UPDATE logs
     SET parsed_input = ?, parsed_output = ?, parsed_at = ?, parser_version = ?
     WHERE id = ? AND (parser_version IS NULL OR parser_version <> ?)`
  ).run(parsedInput, parsedOutput, now(), parserVersion, id, parserVersion);
  return getLog(id);
}

type NumericRow = Record<string, string | number | null>;

function numeric(row: NumericRow, key: string): number {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function nullableNumeric(row: NumericRow, key: string): number | null {
  const value = row[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 近 24 小时看板数据；RPM/TPM 峰值按自然分钟聚合，当前值为滚动 60 秒。 */
export function getDashboardStats(reference = new Date()): DashboardStats {
  const generatedAt = reference.toISOString();
  const windowStartedAt = new Date(reference.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const currentStartedAt = new Date(reference.getTime() - 60 * 1000).toISOString();

  const aggregateColumns = `
    COUNT(s.request_id) AS requests,
    COALESCE(SUM(CASE WHEN s.status = 'success' THEN 1 ELSE 0 END), 0) AS successful_requests,
    COALESCE(SUM(CASE WHEN s.status = 'failed' THEN 1 ELSE 0 END), 0) AS failed_requests,
    COALESCE(SUM(s.input_tokens), 0) AS input_tokens,
    COALESCE(SUM(s.output_tokens), 0) AS output_tokens,
    COALESCE(SUM(s.total_tokens), 0) AS total_tokens,
    COUNT(CASE WHEN s.status = 'success' AND s.total_tokens IS NOT NULL THEN 1 END) AS usage_requests,
    AVG(s.duration_ms) AS average_duration_ms,
    AVG(s.first_byte_ms) AS average_first_byte_ms,
    AVG(CASE
      WHEN s.output_tokens IS NOT NULL AND s.first_byte_ms IS NOT NULL
        AND s.duration_ms > s.first_byte_ms
      THEN s.output_tokens * 1000.0 / (s.duration_ms - s.first_byte_ms)
    END) AS output_tokens_per_second,
    COALESCE(SUM(CASE WHEN s.created_at >= @currentStartedAt THEN 1 ELSE 0 END), 0) AS current_rpm,
    COALESCE(SUM(CASE WHEN s.created_at >= @currentStartedAt THEN s.total_tokens ELSE 0 END), 0) AS current_tpm`;

  const aggregateRows = db.prepare(`
    SELECT m.id AS llm_id, m.name, m.alias, m.model_name, ${aggregateColumns}
    FROM llms m
    LEFT JOIN request_stats s ON s.llm_id = m.id
      AND s.created_at >= @windowStartedAt
      AND s.status IN ('success', 'failed')
    GROUP BY m.id
    ORDER BY requests DESC, m.id ASC
  `).all({ windowStartedAt, currentStartedAt }) as NumericRow[];

  const percentileRows = db.prepare(`
    WITH ranked AS (
      SELECT llm_id, duration_ms,
        ROW_NUMBER() OVER (PARTITION BY llm_id ORDER BY duration_ms) AS row_number,
        COUNT(*) OVER (PARTITION BY llm_id) AS row_count
      FROM request_stats
      WHERE created_at >= ? AND status = 'success'
    )
    SELECT llm_id,
      MIN(CASE WHEN row_number >= ((row_count * 95 + 99) / 100) THEN duration_ms END) AS p95_duration_ms
    FROM ranked
    GROUP BY llm_id
  `).all(windowStartedAt) as Array<{ llm_id: number; p95_duration_ms: number | null }>;
  const percentiles = new Map(
    percentileRows.map((row) => [row.llm_id, row.p95_duration_ms])
  );

  const peakRows = db.prepare(`
    WITH minute_stats AS (
      SELECT llm_id, substr(created_at, 1, 16) AS minute,
        COUNT(*) AS rpm,
        COALESCE(SUM(total_tokens), 0) AS tpm
      FROM request_stats
      WHERE created_at >= ? AND status IN ('success', 'failed')
      GROUP BY llm_id, minute
    )
    SELECT llm_id, MAX(rpm) AS peak_rpm, MAX(tpm) AS peak_tpm
    FROM minute_stats
    GROUP BY llm_id
  `).all(windowStartedAt) as Array<{ llm_id: number; peak_rpm: number; peak_tpm: number }>;
  const peaks = new Map(peakRows.map((row) => [row.llm_id, row]));

  const models: ModelStats24h[] = aggregateRows.map((row) => {
    const requests = numeric(row, "requests");
    const successes = numeric(row, "successful_requests");
    const peak = peaks.get(numeric(row, "llm_id"));
    return {
      llm_id: numeric(row, "llm_id"),
      name: String(row.name),
      alias: String(row.alias),
      model_name: String(row.model_name),
      requests,
      successful_requests: successes,
      failed_requests: numeric(row, "failed_requests"),
      success_rate: requests ? (successes / requests) * 100 : 0,
      current_rpm: numeric(row, "current_rpm"),
      current_tpm: numeric(row, "current_tpm"),
      average_rpm: requests / 1440,
      average_tpm: numeric(row, "total_tokens") / 1440,
      peak_rpm: peak?.peak_rpm ?? 0,
      peak_tpm: peak?.peak_tpm ?? 0,
      input_tokens: numeric(row, "input_tokens"),
      output_tokens: numeric(row, "output_tokens"),
      total_tokens: numeric(row, "total_tokens"),
      token_coverage: successes
        ? (numeric(row, "usage_requests") / successes) * 100
        : 0,
      average_duration_ms: nullableNumeric(row, "average_duration_ms"),
      p95_duration_ms: percentiles.get(numeric(row, "llm_id")) ?? null,
      average_first_byte_ms: nullableNumeric(row, "average_first_byte_ms"),
      output_tokens_per_second: nullableNumeric(row, "output_tokens_per_second"),
    };
  });

  const summaryRow = db.prepare(`
    SELECT ${aggregateColumns}
    FROM request_stats s
    WHERE s.created_at >= @windowStartedAt
      AND s.status IN ('success', 'failed')
  `).get({ windowStartedAt, currentStartedAt }) as NumericRow;
  const summaryRequests = numeric(summaryRow, "requests");
  const summarySuccesses = numeric(summaryRow, "successful_requests");
  const summaryCount = db.prepare(`
    SELECT COUNT(*) AS count FROM request_stats
    WHERE created_at >= ? AND status = 'success'
  `).get(windowStartedAt) as { count: number };
  const p95Offset = Math.max(0, Math.ceil(summaryCount.count * 0.95) - 1);
  const summaryP95 = summaryCount.count
    ? (db.prepare(`
        SELECT duration_ms FROM request_stats
        WHERE created_at >= ? AND status = 'success'
        ORDER BY duration_ms LIMIT 1 OFFSET ?
      `).get(windowStartedAt, p95Offset) as { duration_ms: number }).duration_ms
    : null;
  const overallPeak = db.prepare(`
    WITH minute_stats AS (
      SELECT substr(created_at, 1, 16) AS minute, COUNT(*) AS rpm,
        COALESCE(SUM(total_tokens), 0) AS tpm
      FROM request_stats
      WHERE created_at >= ? AND status IN ('success', 'failed')
      GROUP BY minute
    )
    SELECT COALESCE(MAX(rpm), 0) AS peak_rpm, COALESCE(MAX(tpm), 0) AS peak_tpm
    FROM minute_stats
  `).get(windowStartedAt) as { peak_rpm: number; peak_tpm: number };

  const seriesBucketMinutes = 1;
  const bucketSeconds = seriesBucketMinutes * 60;
  const seriesPointCount = (24 * 60) / seriesBucketMinutes;
  const lastBucket = Math.floor(reference.getTime() / 1000 / bucketSeconds) * bucketSeconds;
  const firstBucket = lastBucket - (seriesPointCount - 1) * bucketSeconds;
  const seriesStartedAt = new Date(firstBucket * 1000).toISOString();
  const rawSeries = db.prepare(`
    SELECT CAST(
      CAST(strftime('%s', created_at) AS INTEGER) / @bucketSeconds AS INTEGER
    ) * @bucketSeconds AS bucket,
      COUNT(*) AS requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_requests,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_requests,
      COALESCE(SUM(total_tokens), 0) AS tokens
    FROM request_stats
    WHERE created_at >= @seriesStartedAt AND status IN ('success', 'failed')
    GROUP BY bucket
  `).all({
    bucketSeconds,
    seriesStartedAt,
  }) as Array<{
    bucket: number;
    requests: number;
    successful_requests: number;
    failed_requests: number;
    tokens: number;
  }>;
  const seriesByBucket = new Map(rawSeries.map((point) => [point.bucket, point]));
  const series = Array.from({ length: seriesPointCount }, (_, index) => {
    const bucket = firstBucket + index * bucketSeconds;
    const point = seriesByBucket.get(bucket);
    return {
      bucket: new Date(bucket * 1000).toISOString(),
      requests: point?.requests ?? 0,
      successful_requests: point?.successful_requests ?? 0,
      failed_requests: point?.failed_requests ?? 0,
      tokens: point?.tokens ?? 0,
    };
  });

  const rawModelSeries = db.prepare(`
    SELECT llm_id,
      CAST(
        CAST(strftime('%s', created_at) AS INTEGER) / @bucketSeconds AS INTEGER
      ) * @bucketSeconds AS bucket,
      COUNT(*) AS requests,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successful_requests,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_requests,
      COALESCE(SUM(total_tokens), 0) AS tokens
    FROM request_stats
    WHERE created_at >= @seriesStartedAt
      AND status IN ('success', 'failed')
      AND llm_id IS NOT NULL
    GROUP BY llm_id, bucket
  `).all({ bucketSeconds, seriesStartedAt }) as Array<{
    llm_id: number;
    bucket: number;
    requests: number;
    successful_requests: number;
    failed_requests: number;
    tokens: number;
  }>;
  const modelSeriesByBucket = new Map(
    rawModelSeries.map((point) => [`${point.llm_id}:${point.bucket}`, point])
  );
  const modelSeries = models.map((model) => ({
    llm_id: model.llm_id,
    points: Array.from({ length: seriesPointCount }, (_, index) => {
      const bucket = firstBucket + index * bucketSeconds;
      const point = modelSeriesByBucket.get(`${model.llm_id}:${bucket}`);
      return {
        bucket: new Date(bucket * 1000).toISOString(),
        requests: point?.requests ?? 0,
        successful_requests: point?.successful_requests ?? 0,
        failed_requests: point?.failed_requests ?? 0,
        tokens: point?.tokens ?? 0,
      };
    }),
  }));

  const localDateKey = (date: Date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };
  const firstDailyDate = new Date(reference);
  firstDailyDate.setHours(0, 0, 0, 0);
  firstDailyDate.setDate(firstDailyDate.getDate() - 13);
  const dailyStartedAt = firstDailyDate.toISOString();
  const dailyKeys = Array.from({ length: 14 }, (_, index) => {
    const date = new Date(firstDailyDate);
    date.setDate(firstDailyDate.getDate() + index);
    return localDateKey(date);
  });
  const rawDailyTokens = db.prepare(`
    SELECT date(created_at, 'localtime') AS date,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_stats
    WHERE created_at >= ? AND status IN ('success', 'failed')
    GROUP BY date
  `).all(dailyStartedAt) as Array<{
    date: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>;
  const dailyTokensByDate = new Map(
    rawDailyTokens.map((point) => [point.date, point])
  );
  const dailyTokens = dailyKeys.map((date) => {
    const point = dailyTokensByDate.get(date);
    return {
      date,
      input_tokens: point?.input_tokens ?? 0,
      output_tokens: point?.output_tokens ?? 0,
      total_tokens: point?.total_tokens ?? 0,
    };
  });

  const rawModelDailyTokens = db.prepare(`
    SELECT llm_id, date(created_at, 'localtime') AS date,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(total_tokens), 0) AS total_tokens
    FROM request_stats
    WHERE created_at >= ?
      AND status IN ('success', 'failed')
      AND llm_id IS NOT NULL
    GROUP BY llm_id, date
  `).all(dailyStartedAt) as Array<{
    llm_id: number;
    date: string;
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  }>;
  const modelDailyTokensByDate = new Map(
    rawModelDailyTokens.map((point) => [`${point.llm_id}:${point.date}`, point])
  );
  const modelDailyTokens = models.map((model) => ({
    llm_id: model.llm_id,
    points: dailyKeys.map((date) => {
      const point = modelDailyTokensByDate.get(`${model.llm_id}:${date}`);
      return {
        date,
        input_tokens: point?.input_tokens ?? 0,
        output_tokens: point?.output_tokens ?? 0,
        total_tokens: point?.total_tokens ?? 0,
      };
    }),
  }));

  return {
    window_started_at: windowStartedAt,
    generated_at: generatedAt,
    series_bucket_minutes: seriesBucketMinutes,
    summary: {
      requests: summaryRequests,
      successful_requests: summarySuccesses,
      failed_requests: numeric(summaryRow, "failed_requests"),
      success_rate: summaryRequests ? (summarySuccesses / summaryRequests) * 100 : 0,
      current_rpm: numeric(summaryRow, "current_rpm"),
      current_tpm: numeric(summaryRow, "current_tpm"),
      average_rpm: summaryRequests / 1440,
      average_tpm: numeric(summaryRow, "total_tokens") / 1440,
      peak_rpm: overallPeak.peak_rpm,
      peak_tpm: overallPeak.peak_tpm,
      input_tokens: numeric(summaryRow, "input_tokens"),
      output_tokens: numeric(summaryRow, "output_tokens"),
      total_tokens: numeric(summaryRow, "total_tokens"),
      token_coverage: summarySuccesses
        ? (numeric(summaryRow, "usage_requests") / summarySuccesses) * 100
        : 0,
      average_duration_ms: nullableNumeric(summaryRow, "average_duration_ms"),
      p95_duration_ms: summaryP95,
      average_first_byte_ms: nullableNumeric(summaryRow, "average_first_byte_ms"),
      output_tokens_per_second: nullableNumeric(summaryRow, "output_tokens_per_second"),
    },
    models,
    series,
    model_series: modelSeries,
    daily_tokens: dailyTokens,
    model_daily_tokens: modelDailyTokens,
  };
}
