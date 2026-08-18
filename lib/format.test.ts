import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRow } from "./types";
import {
  baseUrlForProtocol,
  buildUpstreamUrl,
  requestStreamUsage,
} from "./format";

test("accepts provider roots with or without a trailing v1", () => {
  assert.equal(
    buildUpstreamUrl("https://yibuapi.com", "v1/chat/completions"),
    "https://yibuapi.com/v1/chat/completions",
  );
  assert.equal(
    buildUpstreamUrl("https://yibuapi.com/v1", "v1/chat/completions"),
    "https://yibuapi.com/v1/chat/completions",
  );
  assert.equal(
    buildUpstreamUrl("https://yibuapi.com", "v1/responses"),
    "https://yibuapi.com/v1/responses",
  );
  assert.equal(
    buildUpstreamUrl("https://yibuapi.com/v1", "v1/responses"),
    "https://yibuapi.com/v1/responses",
  );
});

test("selects the protocol-specific URL in separate mode", () => {
  const llm = {
    openai_base_url: "https://api.deepseek.com",
    anthropic_base_url: "https://api.deepseek.com/anthropic",
  } as LlmRow;
  assert.equal(baseUrlForProtocol(llm, "openai"), "https://api.deepseek.com");
  assert.equal(
    baseUrlForProtocol(llm, "openai-responses"),
    "https://api.deepseek.com"
  );
  assert.equal(
    baseUrlForProtocol(llm, "anthropic"),
    "https://api.deepseek.com/anthropic"
  );
});

test("requests usage events for streaming Chat Completions", () => {
  const body = requestStreamUsage(
    JSON.stringify({ model: "alias", stream: true, messages: [] }),
    "openai"
  );
  assert.deepEqual(JSON.parse(body).stream_options, { include_usage: true });
  assert.equal(
    requestStreamUsage(JSON.stringify({ model: "alias", stream: true }), "anthropic"),
    JSON.stringify({ model: "alias", stream: true })
  );
});
