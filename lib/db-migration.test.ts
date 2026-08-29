import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";

test("v15 migration backfills CodeAgent identity from legacy app_id once", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "llm-relay-v14-migration-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  const legacy = new Database(join(dataDir, "relay.db"));
  legacy.exec(`
    CREATE TABLE __schema (version INTEGER NOT NULL);
    INSERT INTO __schema (version) VALUES (14);

    CREATE TABLE llms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      alias TEXT NOT NULL UNIQUE,
      url_mode TEXT NOT NULL DEFAULT 'unified',
      route_mode TEXT NOT NULL DEFAULT 'off',
      openai_base_url TEXT,
      anthropic_base_url TEXT,
      token TEXT NOT NULL,
      app_id TEXT NOT NULL DEFAULT '',
      model_name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      openai_supported INTEGER,
      anthropic_supported INTEGER,
      openai_responses_supported INTEGER,
      protocols_tested_at TEXT
    );

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY,
      llm_id INTEGER,
      llm_alias TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cached_input_tokens INTEGER,
      first_byte_ms INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE request_stats (
      request_id INTEGER PRIMARY KEY,
      llm_id INTEGER,
      llm_alias TEXT NOT NULL,
      status TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER,
      output_tokens INTEGER,
      total_tokens INTEGER,
      cached_input_tokens INTEGER,
      first_byte_ms INTEGER,
      created_at TEXT NOT NULL
    );
  `);
  const insert = legacy.prepare(`
    INSERT INTO llms
      (name, alias, openai_base_url, anthropic_base_url, token, app_id,
       model_name, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const timestamp = "2026-08-29T00:00:00.000Z";
  insert.run(
    "Legacy CodeAgent",
    "legacy-code-agent",
    "https://code-agent.example/v1",
    "https://code-agent.example/v1",
    "token",
    "legacy-app",
    "model",
    timestamp,
    timestamp
  );
  legacy.prepare(
    `UPDATE llms SET openai_supported = 1, anthropic_supported = 0,
      openai_responses_supported = 1, protocols_tested_at = ?
     WHERE alias = ?`
  ).run(timestamp, "legacy-code-agent");
  insert.run(
    "Ordinary",
    "ordinary",
    "https://ordinary.example/v1",
    "https://ordinary.example/v1",
    "token",
    "",
    "model",
    timestamp,
    timestamp
  );
  legacy.close();

  const database = await import("./db");
  t.after(() => {
    database.db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  assert.equal(
    (
      database.db.prepare("SELECT version FROM __schema").get() as {
        version: number;
      }
    ).version,
    15
  );
  assert.equal(database.getLlmByAlias("legacy-code-agent")?.is_code_agent, 1);
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.route_mode,
    "anthropic-to-openai"
  );
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.openai_base_url,
    "https://code-agent.example/v2"
  );
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.anthropic_base_url,
    "https://code-agent.example/v2"
  );
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.openai_supported,
    null
  );
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.anthropic_supported,
    null
  );
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.openai_responses_supported,
    null
  );
  assert.equal(
    database.getLlmByAlias("legacy-code-agent")?.protocols_tested_at,
    null
  );
  assert.equal(database.getLlmByAlias("ordinary")?.is_code_agent, 0);

  // app_id 在 v15 中只是凭证字段，后续修改它不会改变供应商类型。
  database.db
    .prepare("UPDATE llms SET app_id = ? WHERE alias = ?")
    .run("later-metadata", "ordinary");
  assert.equal(database.getLlmByAlias("ordinary")?.is_code_agent, 0);
});
