import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_AGENT_MODEL_PREFIX,
  parseCodeAgentPayload,
} from "./code-agent-config";

const base = {
  access_token: "secret",
  appid: "code-agent-app",
  api_base_url: "https://code-agent.internal/v1",
  models: ["module", "m2"],
};

test("accepts empty models as a not-configured placeholder", () => {
  assert.deepEqual(
    parseCodeAgentPayload({
      access_token: "",
      appid: "",
      api_base_url: "",
      models: [],
    }),
    { inputs: [] }
  );
});

test("generates split protocol URLs while preserving upstream model names", () => {
  const result = parseCodeAgentPayload(base);

  assert.ok("inputs" in result);
  assert.equal(result.inputs.length, 2);
  assert.deepEqual(
    result.inputs.map(({ name, alias, model_name }) => ({
      name,
      alias,
      model_name,
    })),
    ["module", "m2"].map((model) => ({
      name: `${CODE_AGENT_MODEL_PREFIX}${model}`,
      alias: `${CODE_AGENT_MODEL_PREFIX}${model}`,
      model_name: model,
    }))
  );
  assert.equal(result.inputs[0].url_mode, "separate");
  assert.equal(result.inputs[0].app_id, "code-agent-app");
  assert.equal(
    result.inputs[0].openai_base_url,
    "https://code-agent.internal/v1"
  );
  assert.equal(
    result.inputs[0].anthropic_base_url,
    "https://code-agent.internal/v2"
  );
});

test("normalizes CodeAgent roots ending in a version or slash", () => {
  for (const apiBaseUrl of [
    "https://code-agent.internal",
    "https://code-agent.internal/",
    "https://code-agent.internal/v1",
    "https://code-agent.internal/v2",
  ]) {
    const result = parseCodeAgentPayload({
      ...base,
      api_base_url: apiBaseUrl,
      models: ["module"],
    });
    assert.ok("inputs" in result);
    assert.equal(
      result.inputs[0].openai_base_url,
      "https://code-agent.internal/v1"
    );
    assert.equal(
      result.inputs[0].anthropic_base_url,
      "https://code-agent.internal/v2"
    );
  }
});

test("rejects a duplicate model instead of partially syncing", () => {
  const result = parseCodeAgentPayload({ ...base, models: ["module", "module"] });
  assert.deepEqual(result, {
    error: 'models 第 2 项无效：模型 "module" 重复',
  });
});

test("requires credentials when models are present", () => {
  assert.deepEqual(
    parseCodeAgentPayload({ ...base, access_token: "" }),
    { error: "models 非空时 access_token 不能为空" }
  );
  assert.deepEqual(
    parseCodeAgentPayload({ ...base, api_base_url: "" }),
    { error: "models 非空时 api_base_url 不能为空" }
  );
  assert.deepEqual(
    parseCodeAgentPayload({ ...base, appid: "" }),
    { error: "models 非空时 appid 不能为空" }
  );
});

test("keeps special model IDs upstream and generates a safe stable alias", () => {
  const model = "anthropic/claude:sonnet@4";
  const first = parseCodeAgentPayload({ ...base, models: [model] });
  const second = parseCodeAgentPayload({ ...base, models: [model] });

  assert.ok("inputs" in first);
  assert.ok("inputs" in second);
  assert.equal(first.inputs[0].name, `CodeAgent-${model}`);
  assert.equal(first.inputs[0].model_name, model);
  assert.match(
    first.inputs[0].alias,
    /^CodeAgent-anthropic-claude-sonnet-4-[a-f0-9]{8}$/
  );
  assert.equal(first.inputs[0].alias, second.inputs[0].alias);
});
