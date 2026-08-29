import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LlmInput } from "./types";

test("atomically upserts a list of LLMs by alias", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "llm-relay-upsert-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  const database = await import("./db");
  t.after(() => {
    database.db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const initial: LlmInput = {
    name: "CodeAgent",
    alias: "code-agent",
    url_mode: "unified",
    base_url: "https://old.code-agent.internal",
    token: "old-token",
    is_code_agent: true,
    app_id: "app-v1",
    model_name: "old-model",
    enabled: false,
  };
  const secondInitial: LlmInput = {
    ...initial,
    name: "CodeAgent Fast",
    alias: "code-agent-fast",
    model_name: "fast-model",
  };
  const first = database.upsertLlmsByAlias([initial, secondInitial]);
  assert.deepEqual(first, { created: 2, updated: 0 });
  assert.equal(
    (
      database.db.prepare("SELECT version FROM __schema").get() as {
        version: number;
      }
    ).version,
    15
  );

  const initialRows = database.listLlms();
  assert.equal(initialRows.length, 2);
  assert.equal(initialRows[0].enabled, 0);
  assert.equal(initialRows[0].is_code_agent, 1);
  assert.equal(initialRows[0].route_mode, "anthropic-to-openai");
  database.updateProtocolSupport(
    initialRows[0].id,
    true,
    true,
    true,
    "2026-01-01"
  );

  const second = database.upsertLlmsByAlias([
    {
      ...initial,
      base_url: "https://new.code-agent.internal",
      token: "new-token",
      app_id: "app-v2",
      model_name: "new-model",
      enabled: true,
    },
    {
      ...secondInitial,
      token: "new-fast-token",
      model_name: "new-fast-model",
    },
  ]);

  assert.deepEqual(second, { created: 0, updated: 2 });
  const updatedRows = database.listLlms();
  assert.equal(updatedRows.length, 2);
  assert.deepEqual(
    updatedRows.map((row) => row.id),
    initialRows.map((row) => row.id)
  );
  assert.equal(updatedRows[0].token, "new-token");
  assert.equal(updatedRows[0].is_code_agent, 1);
  assert.equal(updatedRows[0].app_id, "app-v2");
  assert.equal(updatedRows[0].model_name, "new-model");
  assert.equal(updatedRows[0].openai_supported, null);
  assert.equal(updatedRows[0].anthropic_supported, null);
  assert.equal(updatedRows[0].openai_responses_supported, null);
  assert.equal(updatedRows[0].route_mode, "anthropic-to-openai");

  database.updateProtocolSupport(
    updatedRows[0].id,
    true,
    true,
    true,
    "2026-01-02"
  );
  const routed = database.updateLlm(updatedRows[0].id, {
    name: updatedRows[0].name,
    alias: updatedRows[0].alias,
    url_mode: updatedRows[0].url_mode,
    route_mode: "off",
    base_url: updatedRows[0].base_url,
    token: updatedRows[0].token,
    model_name: updatedRows[0].model_name,
    enabled: true,
  });
  assert.equal(routed?.route_mode, "off");
  assert.equal(routed?.openai_supported, null);
  assert.equal(routed?.anthropic_supported, null);
  assert.equal(routed?.openai_responses_supported, null);
  assert.equal(routed?.protocols_tested_at, null);
  assert.throws(
    () =>
      database.updateLlm(updatedRows[0].id, {
        name: updatedRows[0].name,
        alias: updatedRows[0].alias,
        url_mode: updatedRows[0].url_mode,
        route_mode: "openai-to-anthropic",
        base_url: updatedRows[0].base_url,
        token: updatedRows[0].token,
        model_name: updatedRows[0].model_name,
        enabled: true,
      }),
    /CodeAgent 没有 Anthropic 后端/
  );

  database.updateProtocolSupport(
    updatedRows[0].id,
    true,
    true,
    true,
    "2026-01-03"
  );

  const editedWithoutAppId = database.updateLlm(updatedRows[0].id, {
    name: updatedRows[0].name,
    alias: updatedRows[0].alias,
    url_mode: updatedRows[0].url_mode,
    base_url: updatedRows[0].base_url,
    token: updatedRows[0].token,
    model_name: updatedRows[0].model_name,
    enabled: false,
  });
  assert.equal(editedWithoutAppId?.app_id, "app-v2");
  assert.equal(editedWithoutAppId?.is_code_agent, 1);
  assert.equal(editedWithoutAppId?.route_mode, "off");
  assert.equal(editedWithoutAppId?.openai_supported, 1);
  assert.equal(editedWithoutAppId?.anthropic_supported, 1);
  assert.equal(editedWithoutAppId?.openai_responses_supported, 1);

  const appIdIsNotAProviderMarker = database.createLlm({
    name: "Ordinary provider",
    alias: "ordinary-with-app-id",
    url_mode: "unified",
    route_mode: "openai-to-anthropic",
    base_url: "https://ordinary.example",
    token: "token",
    app_id: "metadata-only",
    model_name: "ordinary-model",
  });
  assert.equal(appIdIsNotAProviderMarker.is_code_agent, 0);
  assert.equal(appIdIsNotAProviderMarker.route_mode, "openai-to-anthropic");

  assert.throws(
    () =>
      database.createLlm({
        name: "Explicit CodeAgent",
        alias: "explicit-code-agent",
        url_mode: "unified",
        route_mode: "openai-to-anthropic",
        base_url: "https://code-agent.example",
        token: "token",
        is_code_agent: true,
        app_id: "app",
        model_name: "code-agent-model",
      }),
    /CodeAgent 没有 Anthropic 后端/
  );

  assert.throws(
    () =>
      database.createLlm({
        name: "CodeAgent without app id",
        alias: "code-agent-without-app-id",
        url_mode: "unified",
        base_url: "https://code-agent.example",
        token: "token",
        is_code_agent: true,
        model_name: "code-agent-model",
      }),
    /CodeAgent 配置必须填写 app_id/
  );

  const logId = database.insertLog({
    llm_id: updatedRows[0].id,
    llm_alias: updatedRows[0].alias,
    protocol: "openai",
    base_url: updatedRows[0].base_url,
    endpoint: "v1/chat/completions",
    model_name: updatedRows[0].model_name,
    input: "{}",
    output: null,
    status: "streaming",
    error: null,
    duration_ms: 0,
    status_code: null,
  });
  database.updateLog(logId, {
    status: "success",
    input_tokens: 100,
    output_tokens: 20,
    total_tokens: 120,
    cached_input_tokens: 40,
  });
  assert.equal(database.getLog(logId)?.cached_input_tokens, 40);
  assert.equal(
    (
      database.db
        .prepare(
          "SELECT cached_input_tokens FROM request_stats WHERE request_id = ?"
        )
        .get(logId) as { cached_input_tokens: number | null }
    ).cached_input_tokens,
    40
  );

  assert.throws(() =>
    database.upsertLlmsByAlias([
      { ...initial, alias: "must-roll-back" },
      {
        name: "Invalid",
        alias: "invalid-without-url",
        url_mode: "unified",
        token: "secret",
        model_name: "invalid-model",
      },
    ])
  );
  assert.equal(database.listLlms().length, 3);
  assert.equal(
    database.getLlmByAliasIncludingDisabled("must-roll-back"),
    undefined
  );
});
