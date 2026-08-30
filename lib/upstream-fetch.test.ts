import assert from "node:assert/strict";
import test from "node:test";
import { fetchUpstreamWithToolTypeFallback } from "./upstream-fetch";

const standardBody = JSON.stringify({
  model: "m",
  messages: [{ role: "user", content: "hi" }],
  tools: [
    {
      name: "lookup",
      input_schema: { type: "object", properties: {} },
    },
  ],
});

test("retries Anthropic tools with type=function only after the matching 400", async () => {
  const originalFetch = globalThis.fetch;
  const bodies: string[] = [];
  globalThis.fetch = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    if (bodies.length === 1) {
      return Response.json(
        {
          error: {
            message:
              "tools[0].type: unknown variant ``, expected `function` at line 1",
          },
        },
        { status: 400 }
      );
    }
    return Response.json({ ok: true });
  };
  try {
    const result = await fetchUpstreamWithToolTypeFallback(
      "https://provider.example/v1/messages",
      { method: "POST", body: standardBody },
      "anthropic",
      standardBody
    );
    assert.equal(result.response.status, 200);
    assert.equal(result.retriedAnthropicToolType, true);
    assert.equal(bodies.length, 2);
    assert.equal(JSON.parse(bodies[0]).tools[0].type, undefined);
    assert.equal(JSON.parse(bodies[1]).tools[0].type, "function");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("does not retry standard success or unrelated Anthropic errors", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({ ok: true });
  };
  try {
    const success = await fetchUpstreamWithToolTypeFallback(
      "https://provider.example/v1/messages",
      { method: "POST", body: standardBody },
      "anthropic",
      standardBody
    );
    assert.equal(success.retriedAnthropicToolType, false);
    assert.equal(calls, 1);

    globalThis.fetch = async () => {
      calls += 1;
      return Response.json(
        {
          error: {
            message:
              "tools[0]: unknown variant `function`, expected `web_search_20250305`",
          },
        },
        { status: 400 }
      );
    };
    const unrelated = await fetchUpstreamWithToolTypeFallback(
      "https://provider.example/v1/messages",
      { method: "POST", body: standardBody },
      "anthropic",
      standardBody
    );
    assert.equal(unrelated.response.status, 400);
    assert.equal(unrelated.retriedAnthropicToolType, false);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
