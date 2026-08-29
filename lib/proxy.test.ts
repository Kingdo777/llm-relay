import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Protocol } from "./types";

test("bounds SSE logs while preserving passthrough and incremental usage/error", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "llm-relay-proxy-"));
  const previousDataDir = process.env.DATA_DIR;
  const originalFetch = globalThis.fetch;
  process.env.DATA_DIR = dataDir;

  const database = await import("./db");
  const { relayRequest } = await import("./proxy");
  t.after(() => {
    globalThis.fetch = originalFetch;
    database.db.close();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  const llm = database.createLlm({
    name: "Proxy stream test",
    alias: "proxy-stream-test",
    url_mode: "unified",
    base_url: "https://upstream.example/v1",
    token: "test-token",
    model_name: "upstream-model",
    enabled: true,
  });

  const runDirect = async (protocol: Protocol, body: string | string[]) => {
    const expectedBody = Array.isArray(body) ? body.join("") : body;
    const responseBody = Array.isArray(body)
      ? new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder();
            for (const chunk of body) controller.enqueue(encoder.encode(chunk));
            controller.close();
          },
        })
      : body;
    globalThis.fetch = async () =>
      new Response(responseBody, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const result = await relayRequest(
      llm,
      {
        clientProtocol: protocol,
        backendProtocol: protocol,
        baseUrl:
          protocol === "anthropic"
            ? llm.anthropic_base_url
            : llm.openai_base_url,
        routed: false,
      },
      "POST",
      new Headers({ "content-type": "application/json" }),
      JSON.stringify({ model: llm.alias })
    );
    assert.equal(await result.response.text(), expectedBody);
    return database.getLog(result.logId!);
  };
  const startUsage =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"cache_read_input_tokens":2}}}\n\n';
  const oversizedComment = `: ${"x".repeat(1024 * 1024 + 16)}\n\n`;
  const endUsage =
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  const upstreamBody = startUsage + oversizedComment + endUsage;

  globalThis.fetch = async () =>
    new Response(upstreamBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

  const result = await relayRequest(
    llm,
    {
      clientProtocol: "anthropic",
      backendProtocol: "anthropic",
      baseUrl: llm.anthropic_base_url,
      routed: false,
    },
    "POST",
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({ model: llm.alias, max_tokens: 1, messages: [] })
  );

  assert.equal(await result.response.text(), upstreamBody);
  assert.notEqual(result.logId, null);
  const log = database.getLog(result.logId!);
  assert.equal(log?.status, "success");
  assert.equal(log?.input_tokens, 7);
  assert.equal(log?.output_tokens, 3);
  assert.equal(log?.total_tokens, 10);
  assert.equal(log?.cached_input_tokens, 2);
  assert.ok(log?.output?.startsWith(upstreamBody.slice(0, 200_000)));
  assert.ok(
    log?.output?.endsWith(`\n…[已截断，原始长度 ${upstreamBody.length}]`)
  );
  assert.ok((log?.output?.length ?? Infinity) < 201_000);

  const errorBody =
    'data: {"error":{"message":"early stream failure"}}\n\n' +
    oversizedComment +
    "data: [DONE]\n\n";
  globalThis.fetch = async () =>
    new Response(errorBody, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  const failed = await relayRequest(
    llm,
    {
      clientProtocol: "openai",
      backendProtocol: "openai",
      baseUrl: llm.openai_base_url,
      routed: false,
    },
    "POST",
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({ model: llm.alias, stream: true, messages: [] })
  );
  assert.equal(await failed.response.text(), errorBody);
  const failedLog = database.getLog(failed.logId!);
  assert.equal(failedLog?.status, "failed");
  assert.match(failedLog?.error ?? "", /early stream failure/);

  const emptyLog = await runDirect("openai", "");
  assert.equal(emptyLog?.status, "failed");
  assert.match(emptyLog?.error ?? "", /\[DONE\]/);

  const openAiUsageThenDone =
    'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}\n\n' +
    "data: [DONE]\n\n";
  const completedOpenAiLog = await runDirect("openai", openAiUsageThenDone);
  assert.equal(completedOpenAiLog?.status, "success");
  assert.equal(completedOpenAiLog?.total_tokens, 5);

  const missingOpenAiTerminal =
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const truncatedOpenAiLog = await runDirect("openai", missingOpenAiTerminal);
  assert.equal(truncatedOpenAiLog?.status, "failed");
  assert.match(truncatedOpenAiLog?.error ?? "", /\[DONE\]/);

  const missingAnthropicTerminal =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":1}}}\n\n';
  const truncatedAnthropicLog = await runDirect(
    "anthropic",
    missingAnthropicTerminal
  );
  assert.equal(truncatedAnthropicLog?.status, "failed");
  assert.match(truncatedAnthropicLog?.error ?? "", /message_stop/);

  const missingResponsesTerminal =
    'event: response.created\ndata: {"type":"response.created","response":{"usage":{"input_tokens":1,"output_tokens":0,"total_tokens":1}}}\n\n';
  const truncatedResponsesLog = await runDirect(
    "openai-responses",
    missingResponsesTerminal
  );
  assert.equal(truncatedResponsesLog?.status, "failed");
  assert.match(truncatedResponsesLog?.error ?? "", /Responses SSE/);

  const completedResponses =
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n';
  const completedResponsesLog = await runDirect(
    "openai-responses",
    completedResponses
  );
  assert.equal(completedResponsesLog?.status, "success");
  assert.equal(completedResponsesLog?.total_tokens, 3);

  const oversizedCompletedStart =
    'event: response.completed\ndata: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"' +
    "z".repeat(1024 * 1024 + 32);
  const oversizedCompletedEnd = '"}]}]}}\n\n';
  const oversizedCompletedLog = await runDirect("openai-responses", [
    oversizedCompletedStart,
    oversizedCompletedEnd,
  ]);
  assert.equal(oversizedCompletedLog?.status, "success");
  assert.ok(
    oversizedCompletedLog?.output?.endsWith(
      `\n…[已截断，原始长度 ${
        oversizedCompletedStart.length + oversizedCompletedEnd.length
      }]`
    )
  );

  const truncatedOversizedCompletedLog = await runDirect(
    "openai-responses",
    [oversizedCompletedStart]
  );
  assert.equal(truncatedOversizedCompletedLog?.status, "failed");
  assert.match(
    truncatedOversizedCompletedLog?.error ?? "",
    /Responses SSE/
  );
});
