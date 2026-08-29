import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const config = (version: number, llms: Array<Record<string, unknown>>) =>
  new Request("http://localhost/api/llms/import-export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ format: "llm-relay-config", version, llms }),
  });

const item = (alias: string, extra: Record<string, unknown> = {}) => ({
  name: alias,
  alias,
  base_url: "https://provider.example/v1",
  token: "secret",
  model_name: "model",
  ...extra,
});

test("config v4 exports explicit supplier identity and imports v1-v4", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "llm-relay-import-"));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;

  const route = await import("../app/api/llms/import-export/route");
  const database = await import("./db");
  t.after(() => {
    database.db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  let response = await route.POST(config(1, [item("v1-ordinary")]));
  assert.equal(response.status, 200);

  response = await route.POST(
    config(2, [item("v2-code-agent", { app_id: "legacy-app" })])
  );
  assert.equal(response.status, 200);

  response = await route.POST(
    config(3, [
      item("v3-code-agent", {
        app_id: "legacy-app",
        route_mode: "anthropic-to-openai",
      }),
      item("v3-code-agent-explicit-off", {
        app_id: "legacy-app",
        route_mode: "off",
      }),
    ])
  );
  assert.equal(response.status, 200);

  // v4 trusts only the explicit flag: app_id alone is not a provider marker.
  response = await route.POST(
    config(4, [
      item("v4-ordinary-with-app", {
        app_id: "metadata-only",
        is_code_agent: false,
        route_mode: "openai-to-anthropic",
      }),
      item("v4-code-agent", {
        app_id: "current-app",
        is_code_agent: true,
      }),
    ])
  );
  assert.equal(response.status, 200);

  assert.equal(database.getLlmByAlias("v1-ordinary")?.is_code_agent, 0);
  assert.equal(database.getLlmByAlias("v2-code-agent")?.is_code_agent, 1);
  assert.equal(
    database.getLlmByAlias("v2-code-agent")?.route_mode,
    "anthropic-to-openai"
  );
  assert.equal(database.getLlmByAlias("v3-code-agent")?.is_code_agent, 1);
  assert.equal(
    database.getLlmByAlias("v3-code-agent-explicit-off")?.route_mode,
    "off"
  );
  assert.equal(
    database.getLlmByAlias("v4-ordinary-with-app")?.is_code_agent,
    0
  );
  assert.equal(database.getLlmByAlias("v4-code-agent")?.is_code_agent, 1);

  const exported = await route.GET();
  assert.equal(exported.status, 200);
  const payload = (await exported.json()) as {
    version: number;
    llms: Array<{ alias: string; is_code_agent: boolean }>;
  };
  assert.equal(payload.version, 4);
  assert.equal(
    payload.llms.find((llm) => llm.alias === "v4-code-agent")?.is_code_agent,
    true
  );
  assert.equal(
    payload.llms.find((llm) => llm.alias === "v4-ordinary-with-app")
      ?.is_code_agent,
    false
  );

  const modelsRoute = await import("../app/api/models/route");
  const modelsResponse = await modelsRoute.GET();
  const modelsPayload = (await modelsResponse.json()) as {
    models: Array<{ alias: string; is_code_agent: boolean }>;
  };
  assert.equal(
    modelsPayload.models.find((model) => model.alias === "v4-code-agent")
      ?.is_code_agent,
    true
  );

  response = await route.POST(
    config(4, [item("invalid", { is_code_agent: 1 })])
  );
  assert.equal(response.status, 400);
  assert.match(await response.text(), /is_code_agent 必须是布尔值/);
});
