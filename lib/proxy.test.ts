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

  let routedHeaders = new Headers();
  let routedBody: Record<string, unknown> = {};
  let routedUrl = "";
  const codeAgentLlm = {
    ...llm,
    is_code_agent: 1 as const,
    app_id: "code-agent-app",
    openai_base_url: "https://code-agent.example/v1",
    anthropic_base_url: "https://code-agent.example/v1",
  };
  globalThis.fetch = async (input, init) => {
    routedUrl = String(input);
    routedHeaders = new Headers(init?.headers);
    routedBody = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    return Response.json({
      id: "chatcmpl_probe",
      object: "chat.completion",
      model: "upstream-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  };
  const routed = await relayRequest(
    codeAgentLlm,
    {
      clientProtocol: "anthropic",
      backendProtocol: "openai",
      baseUrl: codeAgentLlm.openai_base_url,
      routed: true,
    },
    "POST",
    new Headers({
      "content-type": "application/json",
      accept: "text/event-stream",
    }),
    JSON.stringify({
      model: codeAgentLlm.alias,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    })
  );
  const routedJson = await routed.response.json();
  assert.equal(routedJson.type, "message");
  assert.equal(routedJson.content[0].text, "OK");
  assert.equal(routedUrl, "https://code-agent.example/v2/chat/completions");
  assert.equal(routedBody.stream, false);
  assert.equal(routedHeaders.get("accept"), "application/json");
  assert.equal(routedHeaders.get("x-auth-token"), codeAgentLlm.token);
  assert.equal(routedHeaders.get("app-id"), "code-agent-app");
  assert.equal(database.getLog(routed.logId!)?.endpoint, "v2/chat/completions");

  globalThis.fetch = async () =>
    new Response(
      'data: {"id":"chatcmpl_bad","choices":[]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } }
    );
  const mismatched = await relayRequest(
    codeAgentLlm,
    {
      clientProtocol: "anthropic",
      backendProtocol: "openai",
      baseUrl: codeAgentLlm.openai_base_url,
      routed: true,
    },
    "POST",
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({
      model: codeAgentLlm.alias,
      max_tokens: 16,
      messages: [{ role: "user", content: "hi" }],
    })
  );
  assert.equal(mismatched.response.status, 502);
  const mismatchError = await mismatched.response.json();
  assert.match(mismatchError.error.message, /忽略 stream=false 并返回 SSE/);
  assert.equal(database.getLog(mismatched.logId!)?.status, "failed");

  const routedStart =
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_pumped","type":"message","role":"assistant","model":"upstream-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":2,"output_tokens":0}}}\n\n';
  const routedEnd =
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"done"}}\n\n' +
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":1}}\n\n' +
    'event: message_stop\ndata: {"type":"message_stop"}\n\n';
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder();
          controller.enqueue(encoder.encode(routedStart));
          queueMicrotask(() => {
            controller.enqueue(encoder.encode(routedEnd));
            controller.close();
          });
        },
      }),
      { headers: { "content-type": "text/event-stream" } }
    );
  const unconsumedRouted = await relayRequest(
    llm,
    {
      clientProtocol: "openai-responses",
      backendProtocol: "anthropic",
      baseUrl: llm.anthropic_base_url,
      routed: true,
    },
    "POST",
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({
      model: llm.alias,
      input: "pump the stream",
      store: false,
      stream: true,
    })
  );
  let pumpedLog = database.getLog(unconsumedRouted.logId!);
  for (
    let attempt = 0;
    attempt < 50 && pumpedLog?.status === "streaming";
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    pumpedLog = database.getLog(unconsumedRouted.logId!);
  }
  assert.equal(pumpedLog?.status, "success");
  assert.equal(pumpedLog?.status_code, 200);
  assert.match(pumpedLog?.output ?? "", /response\.completed/);
  await unconsumedRouted.response.body?.cancel();

  let directToolBody: Record<string, unknown> = {};
  globalThis.fetch = async (_input, init) => {
    directToolBody = JSON.parse(String(init?.body ?? "{}")) as Record<
      string,
      unknown
    >;
    return Response.json({
      id: "chatcmpl_tool_type",
      object: "chat.completion",
      model: "upstream-model",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "OK" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    });
  };
  const normalizedToolRequest = await relayRequest(
    llm,
    {
      clientProtocol: "openai",
      backendProtocol: "openai",
      baseUrl: llm.openai_base_url,
      routed: false,
    },
    "POST",
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({
      model: llm.alias,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "",
          function: {
            name: "alarm_lookup",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
    })
  );
  assert.equal(normalizedToolRequest.response.status, 200);
  const forwardedTools = directToolBody.tools as Array<{
    type: string;
  }>;
  assert.equal(forwardedTools[0].type, "function");
});
