import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRow } from "./types";
import {
  baseUrlForProtocol,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  requestStreamUsage,
} from "./format";

test("keeps standard protocol authentication unchanged", () => {
  const openai = buildUpstreamHeaders(
    "openai",
    "openai-token",
    new Headers({
      "content-type": "application/json",
      "x-auth-token": "must-not-leak",
      "app-id": "must-not-leak",
    })
  );
  assert.equal(openai.get("authorization"), "Bearer openai-token");
  assert.equal(openai.get("x-api-key"), null);
  assert.equal(openai.get("x-auth-token"), null);
  assert.equal(openai.get("app-id"), null);

  const anthropic = buildUpstreamHeaders(
    "anthropic",
    "anthropic-token",
    new Headers({ "content-type": "application/json" })
  );
  assert.equal(anthropic.get("authorization"), null);
  assert.equal(anthropic.get("x-api-key"), "anthropic-token");
  assert.equal(anthropic.get("anthropic-version"), "2023-06-01");
});

test("uses x-auth-token and app-id for CodeAgent authentication", () => {
  const headers = buildUpstreamHeaders(
    "openai",
    "code-agent-token",
    new Headers({
      authorization: "Bearer client-token",
      "x-api-key": "client-key",
      "x-auth-token": "client-auth-token",
      "app-id": "client-app",
      "x-innercc-request-kind": "malicious-kind",
      "content-type": "application/json",
    }),
    "server-app"
  );

  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("x-api-key"), null);
  assert.equal(headers.get("x-auth-token"), "code-agent-token");
  assert.equal(headers.get("app-id"), "server-app");
  assert.equal(headers.get("x-innercc-request-kind"), "main_conversation");
  assert.equal(headers.get("content-type"), "application/json");

  const anthropic = buildUpstreamHeaders(
    "anthropic",
    "code-agent-token",
    new Headers({ "content-type": "application/json" }),
    "server-app"
  );
  assert.equal(anthropic.get("authorization"), null);
  assert.equal(anthropic.get("x-api-key"), null);
  assert.equal(anthropic.get("x-auth-token"), "code-agent-token");
  assert.equal(anthropic.get("app-id"), "server-app");
  assert.equal(
    anthropic.get("x-innercc-request-kind"),
    "main_conversation"
  );
  assert.equal(anthropic.get("anthropic-version"), "2023-06-01");
});

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
