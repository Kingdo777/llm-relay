import assert from "node:assert/strict";
import test from "node:test";
import type { RoutePlan } from "./route-plan";
import {
  convertRoutedError,
  convertRoutedRequest,
  convertRoutedResponse,
  createRoutedStreamConverter,
  routedStreamErrorFrame,
} from "./route-conversion";

const llm = { model_name: "upstream-model" };

test("converts an Anthropic route through OpenAI Chat and back", () => {
  const plan: RoutePlan = {
    clientProtocol: "anthropic",
    backendProtocol: "openai",
    baseUrl: "https://openai.example",
    routed: true,
  };
  const request = convertRoutedRequest(
    JSON.stringify({
      model: "upstream-model",
      max_tokens: 32,
      messages: [{ role: "user", content: "hi" }],
    }),
    plan,
    llm
  );
  assert.equal(JSON.parse(request.body).messages[0].content, "hi");

  const response = JSON.parse(
    convertRoutedResponse(
      JSON.stringify({
        id: "chatcmpl_1",
        model: "upstream-model",
        choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      plan,
      llm,
      request.context
    )
  );
  assert.equal(response.type, "message");
  assert.equal(response.content[0].text, "ok");
});

test("converts a Responses route through Anthropic and back", () => {
  const plan: RoutePlan = {
    clientProtocol: "openai-responses",
    backendProtocol: "anthropic",
    baseUrl: "https://anthropic.example",
    routed: true,
  };
  const request = convertRoutedRequest(
    JSON.stringify({
      model: "upstream-model",
      input: "hi",
      max_output_tokens: 32,
      store: false,
    }),
    plan,
    llm
  );
  assert.equal(JSON.parse(request.body).messages[0].content[0].text, "hi");

  const response = JSON.parse(
    convertRoutedResponse(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "upstream-model",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 2, output_tokens: 1 },
      }),
      plan,
      llm,
      request.context
    )
  );
  assert.equal(response.object, "response");
  assert.equal(response.output[0].content[0].text, "ok");
});

test("wraps routed errors in the client protocol shape", () => {
  assert.deepEqual(
    JSON.parse(
      convertRoutedError(
        JSON.stringify({ error: { message: "bad target" } }),
        "anthropic",
        400
      )
    ),
    { type: "error", error: { type: "api_error", message: "bad target" } }
  );
});

test("routes Responses stream fallback through the stateful converter", () => {
  const plan: RoutePlan = {
    clientProtocol: "openai-responses",
    backendProtocol: "anthropic",
    baseUrl: "https://anthropic.example",
    routed: true,
  };
  const converter = createRoutedStreamConverter(plan, llm, {
    clientRequest: { model: "upstream-model", input: "hi", store: false },
  });
  const upstreamStart = `event: message_start\ndata: ${JSON.stringify({
    type: "message_start",
    message: {
      id: "msg_adapter",
      type: "message",
      role: "assistant",
      model: "upstream-model",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 0 },
    },
  })}\n\n`;
  const prefix = converter.feed(upstreamStart);
  const fallback = routedStreamErrorFrame(
    "local conversion failed",
    plan.clientProtocol,
    converter
  );
  const events = (prefix + fallback)
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((frame) => JSON.parse(
      frame.split(/\r?\n/).find((line) => line.startsWith("data:"))!.slice(5).trim()
    ));

  assert.deepEqual(events.map((event) => event.sequence_number), [0, 1, 2]);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.in_progress",
    "response.failed",
  ]);
  assert.equal(events[0].response.id, "resp_adapter");
  assert.equal(events[2].response.id, "resp_adapter");
  assert.equal(events[2].response.error.message, "local conversion failed");
  assert.equal(
    routedStreamErrorFrame("duplicate", plan.clientProtocol, converter),
    ""
  );
});

test("prefers a stateful converter failure frame for every client protocol", () => {
  const converter = {
    feed: () => "",
    finish: () => "",
    failureFrame: (message: string) => `stateful:${message}`,
  };
  assert.equal(
    routedStreamErrorFrame("chat failed", "openai", converter),
    "stateful:chat failed"
  );
  assert.equal(
    routedStreamErrorFrame("messages failed", "anthropic", converter),
    "stateful:messages failed"
  );
  assert.match(routedStreamErrorFrame("plain", "anthropic"), /event: error/);
  assert.match(routedStreamErrorFrame("plain", "openai"), /data: \[DONE\]/);
  assert.throws(
    () => routedStreamErrorFrame("plain", "openai-responses"),
    /有状态转换器/
  );
});
