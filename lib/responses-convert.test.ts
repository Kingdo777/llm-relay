import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicToResponsesSseConverter,
  ConversionError,
  convertAnthropicResponseToResponses,
  convertResponsesRequestToAnthropic,
  createAnthropicToResponsesSseTransform,
} from "./responses-convert";

type RecordValue = Record<string, any>;

function responseEvents(raw: string): RecordValue[] {
  return raw
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((frame) => {
      const data = frame
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      return JSON.parse(data);
    });
}

function anthropicFrame(type: string, payload: RecordValue, crlf = false): string {
  const nl = crlf ? "\r\n" : "\n";
  const normalized = type === "message_start" && payload.message
    ? {
        ...payload,
        message: {
          type: "message",
          role: "assistant",
          stop_reason: null,
          stop_sequence: null,
          ...(payload.message as RecordValue),
        },
      }
    : payload;
  return `event: ${type}${nl}data: ${JSON.stringify({ type, ...normalized })}${nl}${nl}`;
}

test("converts Responses text, instructions, controls and function schemas", () => {
  const converted = convertResponsesRequestToAnthropic({
    model: "public-alias",
    store: false,
    instructions: "Be terse.",
    input: [
      { role: "developer", content: [{ type: "input_text", text: "Use metric." }] },
      { role: "user", content: [{ type: "input_text", text: "weather" }] },
    ],
    max_output_tokens: 123,
    stream: true,
    temperature: 0.2,
    top_p: 0.8,
    stop: ["END"],
    user: "tenant-7",
    parallel_tool_calls: false,
    tool_choice: { type: "function", name: "weather" },
    tools: [{
      type: "function",
      name: "weather",
      description: "Get weather",
      strict: true,
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    }],
  }, { model: "real-model" });

  assert.equal(converted.model, "real-model");
  assert.equal(converted.max_tokens, 123);
  assert.equal(converted.stream, true);
  assert.deepEqual(converted.system, [
    { type: "text", text: "Be terse." },
    { type: "text", text: "Use metric." },
  ]);
  assert.deepEqual(converted.messages, [{
    role: "user",
    content: [{ type: "text", text: "weather" }],
  }]);
  assert.deepEqual(converted.tools, [{
    name: "weather",
    description: "Get weather",
    strict: true,
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  }]);
  assert.deepEqual(converted.tool_choice, {
    type: "tool",
    name: "weather",
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(converted.stop_sequences, ["END"]);
  assert.deepEqual(converted.metadata, { user_id: "tenant-7" });
});

test("converts function calls and results into adjacent Anthropic tool blocks", () => {
  const converted = convertResponsesRequestToAnthropic({
    model: "m",
    store: false,
    input: [
      { role: "user", content: "Run both" },
      { type: "function_call", id: "fc_a", call_id: "call_a", name: "a", arguments: "{\"n\":1}" },
      { type: "function_call", call_id: "call_b", name: "b", arguments: "{}" },
      { type: "function_call_output", call_id: "call_a", output: { ok: true } },
      { type: "function_call_output", call_id: "call_b", output: "done" },
      { role: "user", content: "Summarize" },
    ],
  });

  assert.deepEqual(converted.messages, [
    { role: "user", content: [{ type: "text", text: "Run both" }] },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "call_a", name: "a", input: { n: 1 } },
        { type: "tool_use", id: "call_b", name: "b", input: {} },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "call_a", content: "{\"ok\":true}" },
        { type: "tool_result", tool_use_id: "call_b", content: "done" },
        { type: "text", text: "Summarize" },
      ],
    },
  ]);
});

test("rejects a tool result that follows user text", () => {
  assert.throws(
    () => convertResponsesRequestToAnthropic({
      model: "m",
      store: false,
      input: [
        { type: "function_call", call_id: "call_1", name: "f", arguments: "{}" },
        { role: "user", content: "intervening" },
        { type: "function_call_output", call_id: "call_1", output: "result" },
      ],
    }),
    /不能跟在.*文本之后/
  );
});

test("rejects stateful Responses features, hosted tools and unsupported content", () => {
  const cases: Array<[RecordValue, string, string | undefined]> = [
    [{ model: "m", input: "x" }, "unsupported_responses_feature", "store"],
    [{ model: "m", input: "x", store: false, previous_response_id: "resp_old" }, "unsupported_responses_feature", "previous_response_id"],
    [{ model: "m", input: "x", store: false, conversation: "conv_1" }, "unsupported_responses_feature", "conversation"],
    [{ model: "m", input: "x", store: true }, "unsupported_responses_feature", "store"],
    [{ model: "m", input: "x", store: false, prompt: { id: "pmpt_1" } }, "unsupported_responses_feature", "prompt"],
    [{ model: "m", input: "x", store: false, tools: [{ type: "web_search" }] }, "unsupported_hosted_tool", "tools[0]"],
    [{ model: "m", store: false, input: [{ role: "user", content: [{ type: "input_image", image_url: "x" }] }] }, "unsupported_content", "input[0].content[0]"],
    [{ model: "m", input: "x", store: false, temperature: "hot" }, "invalid_payload", "temperature"],
    [{ model: "m", input: "x", store: false, tools: [{ type: "function", name: "f", parameters: [] }] }, "invalid_payload", "tools[0].parameters"],
  ];

  for (const [body, code, field] of cases) {
    assert.throws(
      () => convertResponsesRequestToAnthropic(body),
      (error) => error instanceof ConversionError && error.code === code && error.field === field
    );
  }
});

test("ignores unknown request extensions and optional unmapped controls", () => {
  const converted = convertResponsesRequestToAnthropic({
    model: "m",
    store: false,
    future_behavior: { enabled: true },
    max_tool_calls: 8,
    include: ["message.output_text.logprobs"],
    prompt_cache_key: "cache-key",
    prompt_cache_retention: "24h",
    prompt_cache_options: { vendor: true },
    top_logprobs: 5,
    logprobs: true,
    metadata: { trace: "ignored upstream" },
    context_management: { type: "compaction" },
    stream_options: { include_usage: true },
    truncation: "auto",
    service_tier: "priority",
    reasoning: { effort: "high" },
    text: {
      format: { type: "text", vendor_format_extension: true },
      verbosity: "high",
      vendor_text_extension: true,
    },
    instructions: [{
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: "Be concise", vendor_block_extension: true }],
      vendor_instruction_extension: true,
    }],
    input: [{
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello", vendor_block_extension: true }],
      vendor_item_extension: true,
    }],
    tools: [{
      type: "function",
      name: "lookup",
      parameters: { type: "object" },
      vendor_tool_extension: true,
    }],
    tool_choice: {
      type: "function",
      name: "lookup",
      vendor_choice_extension: true,
    },
  });

  assert.deepEqual(converted.system, [{ type: "text", text: "Be concise" }]);
  assert.deepEqual(converted.messages, [{
    role: "user",
    content: [{ type: "text", text: "hello" }],
  }]);
  assert.deepEqual(converted.tools, [{
    name: "lookup",
    input_schema: { type: "object" },
  }]);
  assert.deepEqual(converted.tool_choice, { type: "tool", name: "lookup" });
});

test("does not elevate non-system instructions messages", () => {
  assert.throws(
    () => convertResponsesRequestToAnthropic({
      model: "m",
      store: false,
      instructions: [
        { type: "message", role: "user", content: "do not elevate" },
      ],
      input: "hi",
    }),
    /无法转换为 Anthropic system/
  );
});

test("rejects malformed and orphan function items explicitly", () => {
  assert.throws(
    () => convertResponsesRequestToAnthropic({
      model: "m",
      store: false,
      input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{" }],
    }),
    (error) => error instanceof ConversionError && error.code === "invalid_function_arguments"
  );
  assert.throws(
    () => convertResponsesRequestToAnthropic({
      model: "m",
      store: false,
      input: [{ type: "function_call_output", call_id: "missing", output: "x" }],
    }),
    (error) => error instanceof ConversionError && error.code === "orphan_function_call_output"
  );
});

test("validates tool identity, item status and message ordering", () => {
  const invalidBodies: RecordValue[] = [
    {
      model: "m",
      store: false,
      input: [
        { type: "function_call", call_id: "same", name: "a", arguments: "{}" },
        { type: "function_call", call_id: "same", name: "b", arguments: "{}" },
      ],
    },
    {
      model: "m",
      store: false,
      input: [{ type: "function_call", call_id: "c", name: "f", arguments: "{}", status: "incomplete" }],
    },
    {
      model: "m",
      store: false,
      input: [
        { type: "function_call", call_id: "c", name: "f", arguments: "{}" },
        { type: "function_call_output", call_id: "c", output: "one" },
        { type: "function_call_output", call_id: "c", output: "two" },
      ],
    },
    {
      model: "m",
      store: false,
      input: [
        { role: "user", content: "first" },
        { role: "developer", content: "too late" },
      ],
    },
  ];
  for (const body of invalidBodies) {
    assert.throws(() => convertResponsesRequestToAnthropic(body), ConversionError);
  }
});

test("accepts empty output_text metadata when replaying a stateless response", () => {
  const converted = convertResponsesRequestToAnthropic({
    model: "m",
    store: false,
    input: [{
      type: "message",
      id: "msg_old",
      role: "assistant",
      status: "completed",
      content: [{
        type: "output_text",
        text: "prior answer",
        annotations: [],
        logprobs: [],
      }],
    }, { role: "user", content: "continue" }],
  });
  assert.deepEqual(converted.messages, [
    { role: "assistant", content: [{ type: "text", text: "prior answer" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ]);
});

test("converts non-streaming Anthropic text, tools, usage and cache details", () => {
  const response = convertAnthropicResponseToResponses({
    id: "msg_abc",
    type: "message",
    role: "assistant",
    model: "claude-real",
    content: [
      { type: "text", text: "Checking" },
      { type: "tool_use", id: "toolu_1", name: "weather", input: { city: "上海" } },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 7,
      output_tokens: 5,
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 0,
      },
      output_tokens_details: { thinking_tokens: 3 },
    },
  }, {
    createdAt: 1234,
    request: { max_output_tokens: 100, metadata: { trace: "x" } },
  });

  assert.equal(response.id, "resp_abc");
  assert.equal(response.object, "response");
  assert.equal(response.created_at, 1234);
  assert.equal(response.status, "completed");
  assert.equal(response.model, "claude-real");
  assert.deepEqual(response.output, [
    {
      id: "msg_abc",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        annotations: [],
        logprobs: [],
        text: "Checking",
      }],
    },
    {
      id: "toolu_1",
      type: "function_call",
      status: "completed",
      call_id: "toolu_1",
      name: "weather",
      arguments: "{\"city\":\"上海\"}",
    },
  ]);
  assert.deepEqual(response.usage, {
    input_tokens: 19,
    input_tokens_details: { cached_tokens: 7, cache_write_tokens: 2 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 24,
  });
  assert.equal(response.max_output_tokens, 100);
  assert.deepEqual(response.metadata, { trace: "x" });
});

test("ignores Anthropic thinking blocks while preserving visible Responses output", () => {
  const response = convertAnthropicResponseToResponses({
    id: "msg_reasoning",
    type: "message",
    role: "assistant",
    model: "claude-reasoning",
    content: [
      { type: "thinking", thinking: "private reasoning", signature: "sig_1" },
      { type: "text", text: "Visible answer" },
      { type: "redacted_thinking", data: "encrypted-private-data" },
      { type: "tool_use", id: "toolu_reasoning", name: "lookup", input: { q: "x" } },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 2,
      output_tokens: 5,
      output_tokens_details: { thinking_tokens: 3 },
    },
  });

  assert.deepEqual(response.output, [
    {
      id: "msg_reasoning",
      type: "message",
      status: "completed",
      role: "assistant",
      content: [{
        type: "output_text",
        annotations: [],
        logprobs: [],
        text: "Visible answer",
      }],
    },
    {
      id: "toolu_reasoning",
      type: "function_call",
      status: "completed",
      call_id: "toolu_reasoning",
      name: "lookup",
      arguments: '{"q":"x"}',
    },
  ]);
  assert.deepEqual(response.usage, {
    input_tokens: 2,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 7,
  });
});

test("ignores unknown Anthropic response extensions at every converted level", () => {
  const response = convertAnthropicResponseToResponses({
    id: "msg_extensions",
    type: "message",
    role: "assistant",
    model: "m",
    vendor_response_extension: true,
    content: [
      { type: "text", text: "ok", citations: [{ id: "ignored" }], vendor_block_extension: true },
      {
        type: "tool_use",
        id: "toolu_extensions",
        name: "lookup",
        input: { q: "x" },
        vendor_tool_extension: true,
      },
    ],
    stop_reason: "tool_use",
    usage: {
      input_tokens: 1,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      output_tokens: 1,
      vendor_usage_extension: 99,
      billing_usage: {
        vendor_billing_extension: 99,
        openai_usage: {
          prompt_tokens: 999,
          input_tokens: 0,
          completion_tokens: 1,
          output_tokens: 1,
          total_tokens: 1000,
        },
      },
      cache_creation: {
        ephemeral_1h_input_tokens: 2,
        ephemeral_5m_input_tokens: 0,
        vendor_cache_extension: 99,
      },
      output_tokens_details: {
        thinking_tokens: 1,
        vendor_output_extension: 99,
      },
    },
  });

  assert.equal(response.status, "completed");
  assert.equal((response.output as RecordValue[])[0].content[0].text, "ok");
  assert.equal((response.output as RecordValue[])[1].arguments, '{"q":"x"}');
  assert.deepEqual(response.usage, {
    input_tokens: 6,
    input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
    output_tokens: 1,
    output_tokens_details: { reasoning_tokens: 1 },
    total_tokens: 7,
  });
});

test("maps Anthropic max_tokens to an incomplete Responses result", () => {
  const response = convertAnthropicResponseToResponses({
    id: "msg_cut",
    type: "message",
    role: "assistant",
    model: "m",
    content: [{ type: "text", text: "partial" }],
    stop_reason: "max_tokens",
    usage: { input_tokens: 2, output_tokens: 3 },
  });
  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
  assert.equal((response.output as RecordValue[])[0].status, "incomplete");
});

test("rejects malformed Anthropic response usage and role", () => {
  assert.throws(
    () => convertAnthropicResponseToResponses({
      id: "msg_bad",
      type: "message",
      role: "user",
      model: "m",
      content: [{ type: "text", text: "bad" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    /role 必须是 assistant/
  );
  assert.throws(
    () => convertAnthropicResponseToResponses({
      id: "msg_bad_usage",
      type: "message",
      role: "assistant",
      model: "m",
      content: [{ type: "text", text: "bad" }],
      stop_reason: "end_turn",
      usage: { input_tokens: "bad", output_tokens: -1 },
    }),
    /非负整数/
  );
  for (const usage of [
    {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 1,
      cache_creation: { unexpected: 1 },
    },
    { input_tokens: 1, output_tokens: 1, output_tokens_details: "bad" },
    {
      input_tokens: 1,
      output_tokens: 1,
      output_tokens_details: { thinking_tokens: 2 },
    },
  ]) {
    assert.throws(
      () => convertAnthropicResponseToResponses({
        id: "msg_bad_nested_usage",
        type: "message",
        role: "assistant",
        model: "m",
        content: [{ type: "text", text: "bad" }],
        stop_reason: "end_turn",
        usage,
      }),
      ConversionError
    );
  }
});

test("converts Anthropic text SSE fed one UTF-8 byte at a time", () => {
  const input = [
    anthropicFrame("message_start", {
      message: {
        id: "msg_stream",
        model: "claude-stream",
        content: [],
        usage: { input_tokens: 4, cache_read_input_tokens: 6, output_tokens: 0 },
      },
    }, true),
    anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "" },
    }, true),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "你好🌍" },
    }, true),
    anthropicFrame("content_block_stop", { index: 0 }, true),
    anthropicFrame("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        output_tokens: 3,
        output_tokens_details: { thinking_tokens: 2 },
      },
    }, true),
    anthropicFrame("message_stop", {}, true),
  ].join("");

  const converter = new AnthropicToResponsesSseConverter({ createdAt: 50 });
  const bytes = new TextEncoder().encode(input);
  let output = "";
  for (const byte of bytes) output += converter.feed(Uint8Array.of(byte));
  output += converter.finish();

  const events = responseEvents(output);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.equal(events.find((event) => event.type === "response.output_text.delta")?.delta, "你好🌍");
  const completed = events.at(-1)?.response;
  assert.equal(completed.id, "resp_stream");
  assert.equal(completed.output[0].content[0].text, "你好🌍");
  assert.deepEqual(completed.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 6, cache_write_tokens: 0 },
    output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 2 },
    total_tokens: 13,
  });
  assert.deepEqual(events.map((event) => event.sequence_number), events.map((_, index) => index));
});

test("consumes streamed thinking lifecycles without hiding text, tools or usage", () => {
  const input = [
    anthropicFrame("message_start", {
      message: {
        id: "msg_stream_reasoning",
        model: "claude-reasoning",
        content: [],
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    }),
    anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "thinking", thinking: "", signature: "" },
    }),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "thinking_delta", thinking: "private reasoning" },
    }),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "signature_delta", signature: "sig_1" },
    }),
    anthropicFrame("content_block_stop", { index: 0 }),
    anthropicFrame("content_block_start", {
      index: 1,
      content_block: { type: "redacted_thinking", data: "encrypted-private-data" },
    }),
    anthropicFrame("content_block_stop", { index: 1 }),
    anthropicFrame("content_block_start", {
      index: 2,
      content_block: { type: "text", text: "" },
    }),
    anthropicFrame("content_block_delta", {
      index: 2,
      delta: { type: "text_delta", text: "Visible answer" },
    }),
    anthropicFrame("content_block_stop", { index: 2 }),
    anthropicFrame("content_block_start", {
      index: 3,
      content_block: { type: "tool_use", id: "toolu_stream_reasoning", name: "lookup", input: {} },
    }),
    anthropicFrame("content_block_delta", {
      index: 3,
      delta: { type: "input_json_delta", partial_json: '{"q":"x"}' },
    }),
    anthropicFrame("content_block_stop", { index: 3 }),
    anthropicFrame("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: {
        output_tokens: 5,
        output_tokens_details: { thinking_tokens: 3 },
      },
    }),
    anthropicFrame("message_stop", {}),
  ].join("");

  const converter = new AnthropicToResponsesSseConverter({ createdAt: 60 });
  const events = responseEvents(converter.feed(input) + converter.finish());
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.function_call_arguments.delta",
    "response.function_call_arguments.done",
    "response.output_item.done",
    "response.completed",
  ]);
  const completed = events.at(-1)?.response;
  assert.equal(completed.output[0].content[0].text, "Visible answer");
  assert.equal(completed.output[1].arguments, '{"q":"x"}');
  assert.deepEqual(completed.usage, {
    input_tokens: 2,
    input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
    output_tokens: 5,
    output_tokens_details: { reasoning_tokens: 3 },
    total_tokens: 7,
  });
});

test("ignores unknown Anthropic SSE extensions without relaxing lifecycle checks", () => {
  const input = [
    anthropicFrame("ping", { vendor_ping_extension: true }),
    anthropicFrame("message_start", {
      vendor_event_extension: true,
      message: {
        id: "msg_stream_extensions",
        model: "m",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0, vendor_usage_extension: true },
        vendor_message_extension: true,
      },
    }),
    anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "", vendor_block_extension: true },
      vendor_event_extension: true,
    }),
    anthropicFrame("content_block_delta", {
      index: 0,
      delta: { type: "text_delta", text: "ok", vendor_delta_extension: true },
      vendor_event_extension: true,
    }),
    anthropicFrame("content_block_stop", { index: 0, vendor_event_extension: true }),
    anthropicFrame("message_delta", {
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
        vendor_delta_extension: true,
      },
      usage: {
        output_tokens: 1,
        output_tokens_details: { thinking_tokens: 0, vendor_detail_extension: true },
        vendor_usage_extension: true,
      },
      vendor_event_extension: true,
    }),
    anthropicFrame("message_stop", { vendor_event_extension: true }),
  ].join("");

  const converter = new AnthropicToResponsesSseConverter({ createdAt: 1 });
  const events = responseEvents(converter.feed(input) + converter.finish());
  assert.equal(events.at(-1)?.type, "response.completed");
  assert.equal(events.at(-1)?.response.output[0].content[0].text, "ok");
});

test("converts streamed tool argument deltas and validates the completed JSON", () => {
  const input = [
    anthropicFrame("message_start", {
      message: { id: "msg_tool", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    anthropicFrame("content_block_start", {
      index: 1,
      content_block: { type: "tool_use", id: "toolu_city", name: "weather", input: {} },
    }),
    anthropicFrame("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: "{\"city\":\"" },
    }),
    anthropicFrame("content_block_delta", {
      index: 1,
      delta: { type: "input_json_delta", partial_json: "上海\"}" },
    }),
    anthropicFrame("content_block_stop", { index: 1 }),
    anthropicFrame("message_delta", {
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 4 },
    }),
    // Deliberately omit the final blank line to exercise finish().
    anthropicFrame("message_stop", {}).trimEnd(),
  ].join("");
  const converter = new AnthropicToResponsesSseConverter({ responseId: "resp_fixed" });
  const midpoint = Math.floor(input.length / 2);
  const output = converter.feed(input.slice(0, midpoint)) +
    converter.feed(input.slice(midpoint)) +
    converter.finish();
  const events = responseEvents(output);

  assert.deepEqual(
    events.filter((event) => event.type === "response.function_call_arguments.delta").map((event) => event.delta),
    ["{\"city\":\"", "上海\"}"]
  );
  const done = events.find((event) => event.type === "response.function_call_arguments.done");
  assert.equal(done?.arguments, "{\"city\":\"上海\"}");
  const completed = events.at(-1)?.response;
  assert.equal(completed.id, "resp_fixed");
  assert.deepEqual(completed.output[0], {
    id: "toolu_city",
    type: "function_call",
    status: "completed",
    call_id: "toolu_city",
    name: "weather",
    arguments: "{\"city\":\"上海\"}",
  });
});

test("rejects an invalid completed tool JSON stream", () => {
  const converter = new AnthropicToResponsesSseConverter();
  converter.feed(anthropicFrame("message_start", {
    message: { id: "msg_bad", model: "m", content: [], usage: {} },
  }));
  converter.feed(anthropicFrame("content_block_start", {
    index: 0,
    content_block: { type: "tool_use", id: "toolu_bad", name: "bad", input: {} },
  }));
  converter.feed(anthropicFrame("content_block_delta", {
    index: 0,
    delta: { type: "input_json_delta", partial_json: "{" },
  }));
  assert.throws(
    () => converter.feed(anthropicFrame("content_block_stop", { index: 0 })),
    (error) => error instanceof ConversionError && error.code === "invalid_function_arguments"
  );
});

test("fails closed on malformed Anthropic SSE fields and lifecycle", () => {
  const start = anthropicFrame("message_start", {
    message: { id: "msg_strict", model: "m", content: [], usage: {} },
  });

  const mismatched = new AnthropicToResponsesSseConverter();
  assert.throws(
    () => mismatched.feed(
      `event: ping\ndata: ${JSON.stringify({ type: "message_start", message: {} })}\n\n`
    ),
    /不一致/
  );

  const missingIndex = new AnthropicToResponsesSseConverter();
  missingIndex.feed(start);
  assert.throws(
    () => missingIndex.feed(anthropicFrame("content_block_start", {
      content_block: { type: "text", text: "" },
    })),
    /index.*非负整数/
  );

  const unknownBlockField = new AnthropicToResponsesSseConverter();
  unknownBlockField.feed(start);
  assert.throws(
    () => unknownBlockField.feed(anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "text", text: 42, reasoning_content: "secret" },
    })),
    ConversionError
  );

  const prefilledTool = new AnthropicToResponsesSseConverter();
  prefilledTool.feed(start);
  assert.throws(
    () => prefilledTool.feed(anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "tool_use", id: "toolu_prefilled", name: "f", input: { x: 1 } },
    })),
    /input 必须为空对象/
  );

  const reusedIndex = new AnthropicToResponsesSseConverter();
  reusedIndex.feed(start);
  reusedIndex.feed(anthropicFrame("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  }));
  reusedIndex.feed(anthropicFrame("content_block_stop", { index: 0 }));
  assert.throws(
    () => reusedIndex.feed(anthropicFrame("content_block_start", {
      index: 0,
      content_block: { type: "text", text: "again" },
    })),
    /重复/
  );

  const prematureStop = new AnthropicToResponsesSseConverter();
  prematureStop.feed(start);
  prematureStop.feed(anthropicFrame("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  }));
  assert.throws(
    () => prematureStop.feed(anthropicFrame("message_delta", {
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 1 },
    })),
    /content block 结束之前/
  );
});

test("provides a byte TransformStream wrapper", async () => {
  const input = anthropicFrame("message_start", {
    message: { id: "msg_empty", model: "m", content: [], usage: { input_tokens: 1 } },
  }) + anthropicFrame("message_delta", {
    delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 },
  }) + anthropicFrame("message_stop", {});

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(input));
      controller.close();
    },
  });
  const result = await new Response(
    source.pipeThrough(createAnthropicToResponsesSseTransform({ createdAt: 1 }))
  ).text();
  const events = responseEvents(result);
  assert.equal(events[0].type, "response.created");
  assert.equal(events.at(-1)?.type, "response.completed");
});

test("rejects truncated streams and exposes Anthropic error events", () => {
  const truncated = new AnthropicToResponsesSseConverter();
  truncated.feed(
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: "msg_truncated",
        type: "message",
        role: "assistant",
        model: "model",
        content: [],
        stop_reason: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    })}\n\n`
  );
  assert.throws(() => truncated.finish(), /message_stop/);

  const failed = new AnthropicToResponsesSseConverter();
  const output = failed.feed(
    `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "overloaded_error", message: "busy" },
    })}\n\n`
  );
  assert.match(output, /response\.failed/);
  assert.equal(failed.didFail(), true);
  assert.doesNotThrow(() => failed.finish());
});

test("uses the active response id and next sequence for a local failure terminal", () => {
  const converter = new AnthropicToResponsesSseConverter({ createdAt: 77 });
  const sameChunk = anthropicFrame("message_start", {
    message: {
      id: "msg_route_partial",
      model: "upstream-model",
      content: [],
      usage: { input_tokens: 4, output_tokens: 0 },
    },
  }) + anthropicFrame("content_block_start", {
    index: 0,
    content_block: { type: "text", text: "" },
  }) + anthropicFrame("content_block_delta", {
    index: 0,
    delta: { type: "input_json_delta", partial_json: "{}" },
  });
  assert.throws(
    () => converter.feed(sameChunk),
    /与当前 block 不兼容/
  );

  const events = responseEvents(converter.failureFrame("route conversion broke"));
  assert.deepEqual(events.map((event) => event.sequence_number), [0, 1, 2, 3, 4]);
  assert.deepEqual(events.map((event) => event.type), [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.content_part.added",
    "response.failed",
  ]);
  assert.equal(events[0].response.id, "resp_route_partial");
  assert.equal(events[4].response.id, "resp_route_partial");
  assert.equal(events[4].response.status, "failed");
  assert.deepEqual(events[4].response.error, {
    code: "route_conversion_error",
    message: "route conversion broke",
  });
  assert.equal(converter.didFail(), true);

  // A Responses stream can have only one terminal event.
  assert.equal(converter.failureFrame("second failure"), "");
  assert.equal(converter.finish(), "");
});

test("does not append a failure event after a completed Responses stream", () => {
  const converter = new AnthropicToResponsesSseConverter();
  const sameChunk = anthropicFrame("message_start", {
    message: { id: "msg_done", model: "m", content: [], usage: {} },
  }) + anthropicFrame("message_delta", {
    delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 },
  }) + anthropicFrame("message_stop", {}) + anthropicFrame("ping", {});
  assert.throws(() => converter.feed(sameChunk), /终止事件之后/);

  const recovered = responseEvents(converter.failureFrame("too late"));
  assert.deepEqual(recovered.map((event) => event.sequence_number), [0, 1, 2]);
  assert.deepEqual(recovered.map((event) => event.type), [
    "response.created",
    "response.in_progress",
    "response.completed",
  ]);
  assert.equal(converter.didFail(), false);
  assert.equal(converter.failureFrame("duplicate"), "");
});

test("rejects oversized incomplete SSE events", () => {
  const converter = new AnthropicToResponsesSseConverter();
  assert.throws(
    () => converter.feed(`data: ${"x".repeat(1024 * 1024 + 1)}`),
    /1 MiB/
  );
  const complete = new AnthropicToResponsesSseConverter();
  assert.throws(
    () => complete.feed(
      `event: ping\ndata: ${JSON.stringify({
        type: "ping",
        padding: "x".repeat(1024 * 1024),
      })}\n\n`
    ),
    /1 MiB/
  );
});

test("accepts over 1 MiB transport chunks made of small Responses SSE events", () => {
  const pings = anthropicFrame("ping", {}).repeat(40_000);
  assert.ok(pings.length > 1024 * 1024);
  const terminal =
    anthropicFrame("message_start", {
      message: {
        id: "msg_many_events",
        model: "m",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    anthropicFrame("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    anthropicFrame("message_stop", {});
  const output = new AnthropicToResponsesSseConverter({ createdAt: 1 }).feed(
    pings + terminal
  );
  assert.match(output, /response\.completed/);
});

test("rejects invalid UTF-8 split across Responses SSE chunks", () => {
  const converter = new AnthropicToResponsesSseConverter();
  converter.feed(anthropicFrame("message_start", {
    message: { id: "msg_utf8", model: "m", content: [], usage: {} },
  }));
  const encoder = new TextEncoder();
  const prefix = encoder.encode(
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"'
  );
  const first = new Uint8Array(prefix.length + 1);
  first.set(prefix);
  first[prefix.length] = 0xc3;
  assert.equal(converter.feed(first), "");
  const suffix = encoder.encode('"}}\n\n');
  const second = new Uint8Array(suffix.length + 1);
  second[0] = 0x28;
  second.set(suffix, 1);
  assert.throws(
    () => converter.feed(second),
    (error: unknown) =>
      error instanceof ConversionError &&
      error.code === "invalid_utf8" &&
      /UTF-8/.test(error.message)
  );
});

test("caps retained Responses stream content across output items", () => {
  const converter = new AnthropicToResponsesSseConverter();
  converter.feed(anthropicFrame("message_start", {
    message: { id: "msg_total_limit", model: "m", content: [], usage: {} },
  }));
  const fragment = "x".repeat(256 * 1024);
  for (let block = 0; block < 4; block += 1) {
    converter.feed(anthropicFrame("content_block_start", {
      index: block,
      content_block: { type: "text", text: "" },
    }));
    for (let part = 0; part < 16; part += 1) {
      converter.feed(anthropicFrame("content_block_delta", {
        index: block,
        delta: { type: "text_delta", text: fragment },
      }));
    }
    converter.feed(anthropicFrame("content_block_stop", { index: block }));
  }
  converter.feed(anthropicFrame("content_block_start", {
    index: 4,
    content_block: { type: "text", text: "" },
  }));
  assert.throws(
    () => converter.feed(anthropicFrame("content_block_delta", {
      index: 4,
      delta: { type: "text_delta", text: "x" },
    })),
    /累计内容超过 16 MiB/
  );
});
