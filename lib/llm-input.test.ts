import assert from "node:assert/strict";
import test from "node:test";
import { normalizeLlmInput } from "./llm-input";

const base = {
  name: "DeepSeek",
  alias: "deepseek",
  token: "secret",
  model_name: "deepseek-chat",
};

test("normalizes a legacy single Base URL as unified mode", () => {
  const result = normalizeLlmInput({ ...base, base_url: "https://api.deepseek.com" });
  assert.ok("input" in result);
  assert.equal(result.input.url_mode, "unified");
  assert.equal(result.input.openai_base_url, "https://api.deepseek.com");
  assert.equal(result.input.anthropic_base_url, "https://api.deepseek.com");
});

test("keeps separate OpenAI and Anthropic Base URLs", () => {
  const result = normalizeLlmInput({
    ...base,
    url_mode: "separate",
    openai_base_url: "https://api.deepseek.com",
    anthropic_base_url: "https://api.deepseek.com/anthropic",
  });
  assert.ok("input" in result);
  assert.equal(result.input.url_mode, "separate");
  assert.equal(result.input.openai_base_url, "https://api.deepseek.com");
  assert.equal(
    result.input.anthropic_base_url,
    "https://api.deepseek.com/anthropic"
  );
});

test("requires both URLs in separate mode", () => {
  const result = normalizeLlmInput({
    ...base,
    url_mode: "separate",
    openai_base_url: "https://api.deepseek.com",
  });
  assert.deepEqual(result, {
    error: "分离模式下 OpenAI 与 Anthropic Base URL 均为必填",
  });
});

test("preserves a valid protocol route mode", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://api.deepseek.com",
    route_mode: "openai-to-anthropic",
  });
  assert.ok("input" in result);
  assert.equal(result.input.route_mode, "openai-to-anthropic");
});

test("rejects an unknown protocol route mode", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://api.deepseek.com",
    route_mode: "sideways" as "off",
  });
  assert.deepEqual(result, {
    error:
      "路由模式必须是 off、anthropic-to-openai 或 openai-to-anthropic",
  });
});

test("rejects CodeAgent O-to-A routing", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://code-agent.example/v1",
    is_code_agent: true,
    app_id: "app",
    route_mode: "openai-to-anthropic",
  });
  assert.deepEqual(result, {
    error: "CodeAgent 没有 Anthropic 后端，不能使用 O→A 路由",
  });
});

test("does not infer CodeAgent identity from app_id", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://ordinary.example/v1",
    app_id: "metadata-only",
    route_mode: "openai-to-anthropic",
  });
  assert.ok("input" in result);
  assert.equal(result.input.is_code_agent, undefined);
  assert.equal(result.input.route_mode, "openai-to-anthropic");
});

test("preserves an explicit CodeAgent supplier flag", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://code-agent.example/v2",
    is_code_agent: true,
    app_id: "app",
  });
  assert.ok("input" in result);
  assert.equal(result.input.is_code_agent, true);
  assert.equal(result.input.route_mode, "anthropic-to-openai");
  assert.equal(result.input.base_url, "https://code-agent.example/v2");
  assert.equal(result.input.openai_base_url, "https://code-agent.example/v2");
});

test("requires app_id for an explicit CodeAgent config", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://code-agent.example/v1",
    is_code_agent: true,
  });
  assert.deepEqual(result, { error: "CodeAgent 配置必须填写 app_id" });
});

test("normalizes both separate CodeAgent URLs to v2", () => {
  const result = normalizeLlmInput({
    ...base,
    url_mode: "separate",
    openai_base_url: "https://openai.code-agent.example/v1/",
    anthropic_base_url: "https://anthropic.code-agent.example/v2/v1",
    is_code_agent: true,
    app_id: "app",
  });
  assert.ok("input" in result);
  assert.equal(result.input.route_mode, "anthropic-to-openai");
  assert.equal(result.input.openai_base_url, "https://openai.code-agent.example/v2");
  assert.equal(
    result.input.anthropic_base_url,
    "https://anthropic.code-agent.example/v2"
  );
});

test("rejects a non-boolean CodeAgent supplier flag", () => {
  const result = normalizeLlmInput({
    ...base,
    base_url: "https://code-agent.example/v2",
    is_code_agent: 1 as unknown as boolean,
  });
  assert.deepEqual(result, { error: "is_code_agent 必须是布尔值" });
});
