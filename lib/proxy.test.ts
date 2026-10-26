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

  const runDirect = async (
    protocol: Protocol,
    body: string | string[],
    customResponseBody?: ReadableStream<Uint8Array>,
    requestOverrides: Record<string, unknown> = {}
  ) => {
    const expectedBody = Array.isArray(body) ? body.join("") : body;
    const requestBody = JSON.stringify({ ...requestOverrides, model: llm.alias });
    const expectedInputBytes = new TextEncoder().encode(requestBody).byteLength;
    const responseBody =
      customResponseBody ??
      (Array.isArray(body)
        ? new ReadableStream<Uint8Array>({
            start(controller) {
              const encoder = new TextEncoder();
              for (const chunk of body) controller.enqueue(encoder.encode(chunk));
              controller.close();
            },
          })
        : body);
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
      requestBody
    );
    assert.equal(await result.response.text(), expectedBody);
    const storedLog = database.getLog(result.logId!);
    assert.equal(storedLog?.input_bytes, expectedInputBytes);
    return storedLog;
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

  const unicodeInput = `你好🌍${"界".repeat(200_100)}`;
  const unicodeInputLog = await runDirect(
    "openai",
    openAiUsageThenDone,
    undefined,
    { messages: [{ role: "user", content: unicodeInput }] }
  );
  assert.ok((unicodeInputLog?.input_bytes ?? 0) > unicodeInput.length);
  assert.match(unicodeInputLog?.input ?? "", /已截断/);

  const terminalBeforeBrokenTransport =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";
  let upstreamPulls = 0;
  const terminalLog = await runDirect(
    "openai",
    terminalBeforeBrokenTransport,
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          upstreamPulls += 1;
          if (upstreamPulls === 1) {
            controller.enqueue(
              new TextEncoder().encode(terminalBeforeBrokenTransport)
            );
          } else {
            controller.error(new TypeError("terminated"));
          }
        },
      },
      { highWaterMark: 0 }
    )
  );
  assert.equal(upstreamPulls, 1);
  assert.equal(terminalLog?.status, "success");

  const missingOpenAiTerminal =
    'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n';
  const truncatedOpenAiLog = await runDirect("openai", missingOpenAiTerminal);
  assert.equal(truncatedOpenAiLog?.status, "failed");
  assert.match(truncatedOpenAiLog?.error ?? "", /\[DONE\]/);

  const finishReasonWithoutDone =
    'data: {"choices":[{"index":0,"delta":{"content":"complete"},"finish_reason":null}]}\n\n' +
    ": keep-alive\n\n" +
    'data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\n' +
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}';
  const compatibleOpenAiLog = await runDirect(
    "openai",
    finishReasonWithoutDone
  );
  assert.equal(compatibleOpenAiLog?.status, "success");
  assert.equal(compatibleOpenAiLog?.error, null);

  const oneOfTwoChoices =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
  const incompleteMultiChoiceLog = await runDirect(
    "openai",
    oneOfTwoChoices,
    undefined,
    { n: 2 }
  );
  assert.equal(incompleteMultiChoiceLog?.status, "failed");
  assert.match(incompleteMultiChoiceLog?.error ?? "", /\[DONE\]/);

  const invalidChoiceIndex =
    'data: {"choices":[{"index":"bad","delta":{},"finish_reason":"stop"}]}\n\n';
  const invalidChoiceIndexLog = await runDirect("openai", invalidChoiceIndex);
  assert.equal(invalidChoiceIndexLog?.status, "failed");
  assert.match(invalidChoiceIndexLog?.error ?? "", /\[DONE\]/);

  const bothChoices =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"},{"index":1,"delta":{},"finish_reason":"length"}]}\n\n';
  const completeMultiChoiceLog = await runDirect(
    "openai",
    bothChoices,
    undefined,
    { n: 2 }
  );
  assert.equal(completeMultiChoiceLog?.status, "success");

  const excessiveChoices = `data: ${JSON.stringify({
    choices: Array.from({ length: 129 }, (_, index) => ({
      index,
      delta: {},
      finish_reason: "stop",
    })),
  })}\n\n`;
  const excessiveChoicesLog = await runDirect(
    "openai",
    excessiveChoices,
    undefined,
    { n: 129 }
  );
  assert.equal(excessiveChoicesLog?.status, "failed");
  assert.match(excessiveChoicesLog?.error ?? "", /\[DONE\]/);

  const outputAfterFinish =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"late"},"finish_reason":null}]}\n\n';
  const outputAfterFinishLog = await runDirect("openai", outputAfterFinish);
  assert.equal(outputAfterFinishLog?.status, "failed");
  assert.match(outputAfterFinishLog?.error ?? "", /\[DONE\]/);

  const truncatedOutputAfterFinish =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    'data: {"choices":[{"index":0,"delta":{"content":"late';
  const truncatedOutputAfterFinishLog = await runDirect(
    "openai",
    truncatedOutputAfterFinish
  );
  assert.equal(truncatedOutputAfterFinishLog?.status, "failed");
  assert.match(truncatedOutputAfterFinishLog?.error ?? "", /\[DONE\]/);

  const oversizedOutputAfterFinish =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    `data: ${"x".repeat(1024 * 1024 + 32)}`;
  const oversizedOutputAfterFinishLog = await runDirect(
    "openai",
    oversizedOutputAfterFinish
  );
  assert.equal(oversizedOutputAfterFinishLog?.status, "failed");
  assert.match(oversizedOutputAfterFinishLog?.error ?? "", /\[DONE\]/);

  const finishReasonBeforeReset =
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n';
  let resetAfterFinishPulls = 0;
  const resetAfterFinishLog = await runDirect(
    "openai",
    finishReasonBeforeReset,
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          resetAfterFinishPulls += 1;
          if (resetAfterFinishPulls === 1) {
            controller.enqueue(
              new TextEncoder().encode(finishReasonBeforeReset)
            );
          } else {
            controller.error(new TypeError("terminated"));
          }
        },
      },
      { highWaterMark: 0 }
    )
  );
  assert.equal(resetAfterFinishPulls, 2);
  assert.equal(resetAfterFinishLog?.status, "success");

  const routedFinishBeforeReset =
    'data: {"id":"chatcmpl-routed-reset","model":"upstream-model","choices":[{"index":0,"delta":{"role":"assistant","content":"routed complete"},"finish_reason":"stop"}]}\n\n';
  let routedResetPulls = 0;
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>(
        {
          pull(controller) {
            routedResetPulls += 1;
            if (routedResetPulls === 1) {
              controller.enqueue(
                new TextEncoder().encode(routedFinishBeforeReset)
              );
            } else {
              controller.error(new TypeError("terminated"));
            }
          },
        },
        { highWaterMark: 0 }
      ),
      { headers: { "content-type": "text/event-stream" } }
    );
  const routedReset = await relayRequest(
    llm,
    {
      clientProtocol: "anthropic",
      backendProtocol: "openai",
      baseUrl: llm.openai_base_url,
      routed: true,
    },
    "POST",
    new Headers({ "content-type": "application/json" }),
    JSON.stringify({
      model: llm.alias,
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    })
  );
  const routedResetOutput = await routedReset.response.text();
  assert.equal(routedResetPulls, 2);
  assert.match(routedResetOutput, /routed complete/);
  assert.match(routedResetOutput, /event: message_stop/);
  assert.doesNotMatch(routedResetOutput, /event: error/);
  assert.equal(database.getLog(routedReset.logId!)?.status, "success");

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
