import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRow } from "./types";
import {
  baseUrlForProtocol,
  buildUpstreamHeaders,
  buildUpstreamUrl,
  normalizeCodeAgentBaseUrl,
  normalizeRequestToolTypes,
  requestStreamUsage,
  upstreamPathForProtocol,
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
    { appId: "server-app", codeAgent: true }
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
    { appId: "server-app", codeAgent: true }
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

test("does not infer CodeAgent authentication from app-id alone", () => {
  const headers = buildUpstreamHeaders(
    "openai",
    "ordinary-token",
    new Headers({ "content-type": "application/json" }),
    { appId: "incidental-app-id", codeAgent: false }
  );
  assert.equal(headers.get("authorization"), "Bearer ordinary-token");
  assert.equal(headers.get("x-auth-token"), null);
  assert.equal(headers.get("app-id"), null);
  assert.throws(
    () =>
      buildUpstreamHeaders(
        "openai",
        "token",
        new Headers(),
        { codeAgent: true }
      ),
    /缺少 app_id/
  );
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

test("always routes CodeAgent upstream URLs through v2", () => {
  for (const baseUrl of [
    "https://code-agent.internal",
    "https://code-agent.internal/v1",
    "https://code-agent.internal/v2",
    "https://code-agent.internal/v2/v1/",
  ]) {
    assert.equal(
      buildUpstreamUrl(baseUrl, "v1/chat/completions", { codeAgent: true }),
      "https://code-agent.internal/v2/chat/completions"
    );
    assert.equal(
      buildUpstreamUrl(baseUrl, "v1/responses", { codeAgent: true }),
      "https://code-agent.internal/v2/responses"
    );
  }
  assert.equal(
    normalizeCodeAgentBaseUrl("https://code-agent.internal/v1/"),
    "https://code-agent.internal/v2"
  );
  assert.equal(
    buildUpstreamUrl(
      "https://code-agent.internal/gateway/v1?tenant=demo#ignored",
      upstreamPathForProtocol("openai", true),
      { codeAgent: true }
    ),
    "https://code-agent.internal/gateway/v2/chat/completions?tenant=demo"
  );
  assert.equal(upstreamPathForProtocol("openai", true), "v2/chat/completions");
  assert.equal(upstreamPathForProtocol("openai-responses", true), "v2/responses");
  assert.equal(upstreamPathForProtocol("openai", false), "v1/chat/completions");
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

test("fills only unambiguous empty function tool types", () => {
  const chat = JSON.parse(
    normalizeRequestToolTypes(
      JSON.stringify({
        tools: [
          { type: "", function: { name: "a", parameters: {} } },
          { type: null, function: { name: "b", parameters: {} } },
          { function: { name: "c", parameters: {} } },
          { type: "custom", function: { name: "d", parameters: {} } },
          { type: "" },
        ],
      }),
      "openai"
    )
  );
  assert.deepEqual(
    chat.tools.map((tool: { type?: unknown }) => tool.type),
    ["function", "function", "function", "custom", ""]
  );

  const responses = JSON.parse(
    normalizeRequestToolTypes(
      JSON.stringify({
        tools: [
          { type: " ", name: "lookup", parameters: {} },
          { type: "web_search_preview" },
        ],
      }),
      "openai-responses"
    )
  );
  assert.deepEqual(
    responses.tools.map((tool: { type?: unknown }) => tool.type),
    ["function", "web_search_preview"]
  );

  const anthropic = JSON.stringify({
    tools: [{ type: "", name: "lookup", input_schema: {} }],
  });
  assert.equal(
    normalizeRequestToolTypes(anthropic, "anthropic"),
    anthropic
  );
});
