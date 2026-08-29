import assert from "node:assert/strict";
import test from "node:test";
import type { LlmRow } from "./types";
import { testLlm } from "./test-llm";

test("does not send an Anthropic probe for CodeAgent", async () => {
  const result = await testLlm(
    {
      app_id: "code-agent-app",
      route_mode: "off",
      name: "CodeAgent",
      openai_base_url: "https://code-agent.example/v1",
      anthropic_base_url: "https://code-agent.example/v1",
    } as LlmRow,
    "anthropic"
  );
  assert.deepEqual(result, {
    success: false,
    message: "CodeAgent 不支持 Anthropic 协议；可选择 A→O 路由",
  });
});

test("probes routed client protocols through their target backend", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: Record<string, unknown>; headers: Headers }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    if (url.endsWith("/v1/chat/completions")) {
      return Response.json({
        id: "chatcmpl_probe",
        model: "model",
        choices: [
          {
            message: { role: "assistant", content: "OK" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      });
    }
    return Response.json({
      id: "msg_probe",
      type: "message",
      role: "assistant",
      model: "model",
      content: [{ type: "text", text: "OK" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 1 },
    });
  };

  try {
    const codeAgent = {
      name: "CodeAgent",
      model_name: "model",
      token: "token",
      app_id: "app",
      route_mode: "anthropic-to-openai",
      openai_base_url: "https://code-agent.example/v1",
      anthropic_base_url: "https://code-agent.example/v1",
    } as LlmRow;
    const anthropic = await testLlm(codeAgent, "anthropic");
    assert.equal(anthropic.success, true);
    assert.match(anthropic.message, /路由成功 anthropic→openai/);
    assert.equal(calls[0].url, "https://code-agent.example/v1/chat/completions");
    assert.ok(Array.isArray(calls[0].body.messages));
    assert.equal(calls[0].headers.get("x-auth-token"), "token");

    const reverse = {
      ...codeAgent,
      app_id: "",
      route_mode: "openai-to-anthropic",
      openai_base_url: "https://openai.example/v1",
      anthropic_base_url: "https://anthropic.example/v1",
    } as LlmRow;
    const responses = await testLlm(reverse, "openai-responses");
    assert.equal(responses.success, true);
    assert.match(responses.message, /路由成功 openai-responses→anthropic/);
    assert.equal(calls[1].url, "https://anthropic.example/v1/messages");
    assert.ok(Array.isArray(calls[1].body.messages));
    assert.equal(calls[1].headers.get("x-api-key"), "token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
