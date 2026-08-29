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

  const initialRows = database.listLlms();
  assert.equal(initialRows.length, 2);
  assert.equal(initialRows[0].enabled, 0);
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
  assert.equal(updatedRows[0].app_id, "app-v2");
  assert.equal(updatedRows[0].model_name, "new-model");
  assert.equal(updatedRows[0].openai_supported, null);
  assert.equal(updatedRows[0].anthropic_supported, null);
  assert.equal(updatedRows[0].openai_responses_supported, null);

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
  assert.equal(database.listLlms().length, 2);
  assert.equal(
    database.getLlmByAliasIncludingDisabled("must-roll-back"),
    undefined
  );
});
