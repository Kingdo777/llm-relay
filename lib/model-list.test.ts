import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRow } from "./types";
import {
  buildAnthropicModelsPayload,
  buildOpenAiModelsPayload,
  createModelsResponse,
  isAnthropicModelsRequest,
} from "./model-list";

const models = [
  {
    alias: "model-a",
    name: "Model A",
    enabled: 1,
    created_at: "2026-08-27T01:02:03.000Z",
    route_mode: "off",
    openai_base_url: "https://example.com",
    anthropic_base_url: "https://example.com",
    anthropic_supported: 1,
    app_id: "",
  },
  {
    alias: "model-b",
    name: "Model B",
    enabled: 1,
    created_at: "2026-08-27T02:03:04.000Z",
    route_mode: "off",
    openai_base_url: "https://example.com",
    anthropic_base_url: "https://example.com",
    anthropic_supported: 0,
    app_id: "",
  },
  {
    alias: "disabled",
    name: "Disabled",
    enabled: 0,
    created_at: "2026-08-27T03:04:05.000Z",
    route_mode: "off",
    openai_base_url: "https://example.com",
    anthropic_base_url: "https://example.com",
    anthropic_supported: 1,
    app_id: "",
  },
  {
    alias: "CodeAgent-model",
    name: "CodeAgent Model",
    enabled: 1,
    created_at: "2026-08-27T04:05:06.000Z",
    route_mode: "off",
    openai_base_url: "https://code-agent.example/v1",
    anthropic_base_url: "https://code-agent.example/v1",
    anthropic_supported: null,
    app_id: "code-agent-app",
  },
  {
    alias: "CodeAgent-routed",
    name: "CodeAgent Routed",
    enabled: 1,
    created_at: "2026-08-27T05:06:07.000Z",
    route_mode: "anthropic-to-openai",
    openai_base_url: "https://code-agent.example/v1",
    anthropic_base_url: "https://code-agent.example/v1",
    anthropic_supported: 1,
    app_id: "code-agent-app",
  },
] as LlmRow[];

test("detects Anthropic model-list requests from standard SDK headers", () => {
  assert.equal(
    isAnthropicModelsRequest(new Headers({ "anthropic-version": "2023-06-01" })),
    true,
  );
  assert.equal(
    isAnthropicModelsRequest(new Headers({ "anthropic-beta": "models-2025-02-19" })),
    true,
  );
  assert.equal(
    isAnthropicModelsRequest(new Headers({ "x-api-key": "placeholder" })),
    true,
  );
  assert.equal(
    isAnthropicModelsRequest(
      new Headers({
        authorization: "Bearer placeholder",
        "x-api-key": "placeholder",
      }),
    ),
    false,
  );
});

test("keeps the existing OpenAI model-list response", () => {
  assert.deepEqual(buildOpenAiModelsPayload(models), {
    object: "list",
    data: [
      {
        id: "model-a",
        object: "model",
        created: 1787792523,
        owned_by: "llm-relay",
      },
      {
        id: "model-b",
        object: "model",
        created: 1787796184,
        owned_by: "llm-relay",
      },
      {
        id: "CodeAgent-model",
        object: "model",
        created: 1787803506,
        owned_by: "llm-relay",
      },
      {
        id: "CodeAgent-routed",
        object: "model",
        created: 1787807167,
        owned_by: "llm-relay",
      },
    ],
  });
});

test("returns only usable Anthropic models in Anthropic format", () => {
  assert.deepEqual(buildAnthropicModelsPayload(models), {
    data: [
      {
        id: "model-a",
        created_at: "2026-08-27T01:02:03.000Z",
        display_name: "Model A",
        type: "model",
        capabilities: null,
        max_input_tokens: null,
        max_tokens: null,
      },
      {
        id: "CodeAgent-routed",
        created_at: "2026-08-27T05:06:07.000Z",
        display_name: "CodeAgent Routed",
        type: "model",
        capabilities: null,
        max_input_tokens: null,
        max_tokens: null,
      },
    ],
    first_id: "model-a",
    has_more: false,
    last_id: "CodeAgent-routed",
  });
});

test("selects the payload format from the incoming request", async () => {
  const anthropicResponse = createModelsResponse(
    new Request("http://relay.test/v1/models", {
      headers: { "anthropic-version": "2023-06-01" },
    }),
    models,
  );
  const anthropicBody = await anthropicResponse.json();
  assert.equal(anthropicBody.data[0].display_name, "Model A");
  assert.equal(anthropicBody.object, undefined);

  const openAiResponse = createModelsResponse(
    new Request("http://relay.test/v1/models", {
      headers: { authorization: "Bearer placeholder" },
    }),
    models,
  );
  const openAiBody = await openAiResponse.json();
  assert.equal(openAiBody.object, "list");
  assert.equal(openAiBody.data[0].owned_by, "llm-relay");
});
