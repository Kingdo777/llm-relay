import assert from "node:assert/strict";
import test from "node:test";
import {
  AnthropicToOpenAIStreamConverter,
  ConversionError,
  OpenAIToAnthropicStreamConverter,
  antRespToOai,
  convertAnthropicRequestToOpenAIChat,
  convertAnthropicResponseToOpenAIChat,
  convertOpenAIChatRequestToAnthropic,
  convertOpenAIChatResponseToAnthropic,
  createAnthropicToOpenAIChatSseTransform,
  createOpenAIChatToAnthropicSseTransform,
  oaiRespToAnt,
} from "./protocol-convert";

interface ParsedSse {
  event: string;
  data: unknown;
}

function parseSse(raw: string): ParsedSse[] {
  return raw
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      const data: string[] = [];
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      const joined = data.join("\n");
      return {
        event,
        data: joined === "[DONE]" ? joined : JSON.parse(joined),
      };
    });
}

function anthropicEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function openAIEvent(data: Record<string, unknown>): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

test("OpenAI request -> Anthropic maps system, tools, results, stop and options", () => {
  const converted = convertOpenAIChatRequestToAnthropic({
    model: "gpt-model",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "system", content: [{ type: "text", text: "Use tools." }] },
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "weather", arguments: '{"city":"上海"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "clock", arguments: "" },
          },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "sunny" },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: [{ type: "text", text: "12:00" }],
      },
    ],
    max_completion_tokens: 300,
    temperature: 0.2,
    top_p: 0.9,
    stop: ["END", "STOP"],
    stream: true,
    stream_options: { include_usage: true },
    tools: [
      {
        type: "function",
        function: {
          name: "weather",
          description: "Look up weather",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
          },
          strict: true,
        },
      },
    ],
    tool_choice: { type: "function", function: { name: "weather" } },
    parallel_tool_calls: false,
    user: "u-1",
  });

  assert.equal(converted.system, "You are terse.\n\nUse tools.");
  assert.equal(converted.max_tokens, 300);
  assert.deepEqual(converted.stop_sequences, ["END", "STOP"]);
  assert.deepEqual(converted.metadata, { user_id: "u-1" });
  assert.deepEqual(converted.tool_choice, {
    type: "tool",
    name: "weather",
    disable_parallel_tool_use: true,
  });
  assert.deepEqual(converted.tools, [
    {
      name: "weather",
      description: "Look up weather",
      input_schema: {
        type: "object",
        properties: { city: { type: "string" } },
      },
      strict: true,
    },
  ]);
  assert.deepEqual(converted.messages, [
    { role: "user", content: "weather?" },
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: "call_1",
          name: "weather",
          input: { city: "上海" },
        },
        {
          type: "tool_use",
          id: "call_2",
          name: "clock",
          input: {},
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "call_1",
          content: "sunny",
        },
        {
          type: "tool_result",
          tool_use_id: "call_2",
          content: "12:00",
        },
      ],
    },
  ]);
});

test("OpenAI tool_choice none removes tool definitions", () => {
  const converted = convertOpenAIChatRequestToAnthropic({
    model: "m",
    messages: [{ role: "user", content: "hi" }],
    tools: [
      {
        type: "function",
        function: { name: "noop", parameters: { type: "object" } },
      },
    ],
    tool_choice: "none",
    parallel_tool_calls: false,
  });
  assert.equal("tools" in converted, false);
  assert.equal("tool_choice" in converted, false);
});

test("tool results never follow text in the same converted Anthropic user turn", () => {
  assert.throws(
    () => convertOpenAIChatRequestToAnthropic({
      model: "m",
      messages: [
        { role: "user", content: "intervening" },
        { role: "tool", tool_call_id: "call_1", content: "result" },
      ],
    }),
    /tool 结果不能跟在.*文本之后/
  );

  assert.throws(
    () =>
      convertAnthropicRequestToOpenAIChat({
        model: "m",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "intervening" },
              { type: "tool_result", tool_use_id: "call_1", content: "result" },
            ],
          },
        ],
      }),
    /must precede text/
  );
});

test("Anthropic request -> OpenAI maps block order and strict tools", () => {
  const converted = convertAnthropicRequestToOpenAIChat({
    model: "claude-model",
    system: [
      {
        type: "text",
        text: "System A. ",
      },
      { type: "text", text: "System B." },
    ],
    messages: [
      { role: "user", content: "question" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "checking" },
          {
            type: "tool_use",
            id: "toolu_1",
            name: "search",
            input: { q: "relay" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_1",
            content: [{ type: "text", text: "found" }],
            is_error: false,
          },
          { type: "text", text: "continue" },
        ],
      },
    ],
    max_tokens: 500,
    stop_sequences: ["done"],
    stream: true,
    tools: [
      {
        name: "search",
        description: "Search",
        input_schema: { type: "object", properties: { q: { type: "string" } } },
        strict: true,
      },
    ],
    tool_choice: {
      type: "any",
      disable_parallel_tool_use: true,
    },
    metadata: { user_id: "anth-user" },
  });

  assert.equal(converted.stop, "done");
  assert.deepEqual(converted.stream_options, { include_usage: true });
  assert.equal(converted.tool_choice, "required");
  assert.equal(converted.parallel_tool_calls, false);
  assert.equal(converted.user, "anth-user");
  assert.equal(
    (
      converted.tools as Array<{
        function: { strict?: boolean };
      }>
    )[0].function.strict,
    true
  );
  assert.deepEqual(converted.messages, [
    { role: "system", content: "System A. System B." },
    { role: "user", content: "question" },
    {
      role: "assistant",
      content: "checking",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "search", arguments: '{"q":"relay"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "toolu_1", content: "found" },
    { role: "user", content: "continue" },
  ]);
});

test("Anthropic request -> OpenAI explicitly preserves non-streaming mode", () => {
  const converted = convertAnthropicRequestToOpenAIChat({
    model: "claude-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
  });

  assert.equal(converted.stream, false);
  assert.equal(converted.stream_options, undefined);
});

test("Anthropic request -> OpenAI ignores non-semantic timestamp metadata", () => {
  const converted = convertAnthropicRequestToOpenAIChat({
    model: "claude-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
    request_timestamp: "2026-08-29T12:34:56.000Z",
    created_timestamp: 1788000000,
  });

  assert.equal(converted.request_timestamp, undefined);
  assert.equal(converted.created_timestamp, undefined);
  assert.deepEqual(converted.messages, [{ role: "user", content: "hi" }]);
});

test("Anthropic request -> OpenAI accepts and ignores thinking config", () => {
  const converted = convertAnthropicRequestToOpenAIChat({
    model: "claude-model",
    max_tokens: 32,
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "enabled", budget_tokens: 1024 },
  });

  assert.equal(converted.thinking, undefined);
  assert.deepEqual(converted.messages, [{ role: "user", content: "hi" }]);
});

test("request conversion ignores unknown extensions but still rejects invalid core semantics", () => {
  const openAI = convertOpenAIChatRequestToAnthropic({
    model: "m",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi", vendor_block_metadata: true }],
        vendor_message_metadata: { trace: "abc" },
      },
    ],
    response_format: { type: "json_object" },
    vendor_request_metadata: { trace: "abc" },
    tools: [
      {
        type: "function",
        vendor_tool_metadata: true,
        function: {
          name: "noop",
          parameters: { type: "object" },
          vendor_function_metadata: true,
        },
      },
    ],
  });
  assert.deepEqual(openAI.messages, [{ role: "user", content: "hi" }]);
  assert.equal(openAI.response_format, undefined);
  assert.equal(openAI.vendor_request_metadata, undefined);

  const anthropic = convertAnthropicRequestToOpenAIChat({
    model: "m",
    max_tokens: 10,
    messages: [
      {
        role: "user",
        vendor_message_metadata: true,
        content: [{ type: "text", text: "hi", vendor_block_metadata: true }],
      },
    ],
    vendor_request_metadata: true,
  });
  assert.deepEqual(anthropic.messages, [{ role: "user", content: "hi" }]);
  assert.equal(anthropic.vendor_request_metadata, undefined);

  assert.throws(
    () =>
      convertAnthropicRequestToOpenAIChat({
        model: "m",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [{ type: "image", source: { type: "base64" } }],
          },
        ],
      }),
    ConversionError
  );
  const cached = convertAnthropicRequestToOpenAIChat({
    model: "m",
    max_tokens: 10,
    system: [
      {
        type: "text",
        text: "cached",
        cache_control: { type: "ephemeral", ttl: "1h" },
      },
    ],
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual((cached.messages as unknown[])[0], {
    role: "system",
    content: "cached",
  });
  assert.throws(
    () =>
      convertAnthropicRequestToOpenAIChat({
        model: "m",
        max_tokens: 10,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: "failed",
                is_error: true,
              },
            ],
          },
        ],
      }),
    /错误工具结果/
  );
  assert.throws(
    () =>
      convertOpenAIChatRequestToAnthropic({
        model: "m",
        messages: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "x",
                type: "function",
                function: { name: "f", arguments: "{bad" },
              },
            ],
          },
        ],
      }),
    /Invalid JSON/
  );
});

test("optional request fields treat null as omitted", () => {
  const openAI = convertOpenAIChatRequestToAnthropic({
    model: "m",
    messages: [
      {
        role: "assistant",
        content: null,
        tool_calls: null,
        tool_call_id: null,
        name: null,
        refusal: null,
      },
    ],
    max_tokens: null,
    max_completion_tokens: null,
    temperature: null,
    top_p: null,
    stop: null,
    stream: null,
    stream_options: null,
    tools: null,
    tool_choice: null,
    parallel_tool_calls: null,
    user: null,
  });
  assert.equal(openAI.max_tokens, 1024);
  assert.deepEqual(openAI.messages, [{ role: "assistant", content: "" }]);

  const anthropic = convertAnthropicRequestToOpenAIChat({
    model: "m",
    max_tokens: 10,
    messages: [{ role: "user", content: "hi" }],
    system: null,
    temperature: null,
    top_p: null,
    stop_sequences: null,
    stream: null,
    tools: null,
    tool_choice: null,
    metadata: null,
  });
  assert.equal(anthropic.stream, false);
  assert.deepEqual(anthropic.messages, [{ role: "user", content: "hi" }]);
});

test("Anthropic response -> OpenAI preserves text, tool calls and cache usage", () => {
  const converted = convertAnthropicResponseToOpenAIChat({
    id: "msg_123",
    type: "message",
    role: "assistant",
    model: "claude",
    content: [
      { type: "text", text: "I'll check.", vendor_block_metadata: true },
      {
        type: "tool_use",
        id: "toolu_9",
        name: "lookup",
        input: { id: 9 },
        vendor_tool_metadata: true,
      },
    ],
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      input_tokens: 70,
      output_tokens: 8,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 10,
      cache_creation: {
        ephemeral_1h_input_tokens: 20,
        ephemeral_5m_input_tokens: 0,
      },
      output_tokens_details: { thinking_tokens: 2, vendor_usage_detail: 1 },
      vendor_usage_metadata: true,
    },
    vendor_response_metadata: true,
  });

  assert.equal(converted.id, "msg_123");
  assert.deepEqual(converted.usage, {
    prompt_tokens: 100,
    completion_tokens: 8,
    total_tokens: 108,
    prompt_tokens_details: { cached_tokens: 10, cache_write_tokens: 20 },
    completion_tokens_details: { reasoning_tokens: 2 },
  });
  const choice = (converted.choices as Array<Record<string, unknown>>)[0];
  assert.equal(choice.finish_reason, "tool_calls");
  assert.deepEqual(choice.message, {
    role: "assistant",
    content: "I'll check.",
    tool_calls: [
      {
        id: "toolu_9",
        type: "function",
        function: { name: "lookup", arguments: '{"id":9}' },
      },
    ],
  });

  const throughStringApi = JSON.parse(
    antRespToOai(
      JSON.stringify({
        id: "msg_string",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
      "fallback"
    )
  );
  assert.equal(throughStringApi.model, "fallback");
});

test("OpenAI response -> Anthropic preserves tool calls and cached token semantics", () => {
  const converted = convertOpenAIChatResponseToAnthropic({
    id: "chatcmpl_1",
    object: "chat.completion",
    created: 123,
    request_timestamp: "2026-08-29T12:34:56.000Z",
    created_timestamp: 1788000000,
    model: "gpt",
    choices: [
      {
        index: 0,
        vendor_choice_metadata: true,
        message: {
          role: "assistant",
          content: "Calling it",
          reasoning_content: "provider-private reasoning",
          thinking: "provider-private thinking",
          vendor_message_metadata: true,
          tool_calls: [
            {
              id: "call_7",
              type: "function",
              vendor_tool_metadata: true,
              function: {
                name: "lookup",
                arguments: '{"x":7}',
                vendor_function_metadata: true,
              },
            },
          ],
        },
        finish_reason: "tool_calls",
        logprobs: null,
      },
    ],
    usage: {
      prompt_tokens: 100,
      completion_tokens: 11,
      total_tokens: 111,
      prompt_tokens_details: {
        cached_tokens: 35,
        cache_write_tokens: 15,
        vendor_prompt_detail: 1,
      },
      completion_tokens_details: {
        reasoning_tokens: 4,
        vendor_completion_detail: 1,
      },
      vendor_usage_metadata: true,
    },
    vendor_response_metadata: true,
  });

  assert.equal(converted.stop_reason, "tool_use");
  assert.equal(converted.request_timestamp, undefined);
  assert.equal(converted.created_timestamp, undefined);
  assert.deepEqual(converted.content, [
    { type: "text", text: "Calling it" },
    { type: "tool_use", id: "call_7", name: "lookup", input: { x: 7 } },
  ]);
  assert.deepEqual(converted.usage, {
    input_tokens: 50,
    output_tokens: 11,
    cache_creation_input_tokens: 15,
    cache_read_input_tokens: 35,
    output_tokens_details: { thinking_tokens: 4 },
  });

  const throughStringApi = JSON.parse(
    oaiRespToAnt(
      JSON.stringify({
        id: "chatcmpl_string",
        choices: [
          {
            message: { role: "assistant", content: "ok", tool_calls: null },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
      }),
      "fallback"
    )
  );
  assert.equal(throughStringApi.model, "fallback");
});

test("Anthropic response -> OpenAI maps thinking and ignores redacted thinking", () => {
  const converted = convertAnthropicResponseToOpenAIChat({
    id: "msg_thinking",
    type: "message",
    role: "assistant",
    model: "claude",
    content: [
      { type: "thinking", thinking: "first ", signature: "opaque-signature" },
      { type: "redacted_thinking", data: "opaque-redacted-data" },
      { type: "thinking", thinking: "second" },
      { type: "text", text: "answer" },
    ],
    stop_reason: "end_turn",
    usage: { input_tokens: 2, output_tokens: 3 },
  });

  const choice = (converted.choices as Array<Record<string, unknown>>)[0];
  assert.deepEqual(choice.message, {
    role: "assistant",
    content: "answer",
    reasoning_content: "first second",
  });
});

test("non-streaming responses reject lossy multi-choice, unknown blocks and invalid cache", () => {
  assert.throws(
    () =>
      convertOpenAIChatResponseToAnthropic({
        id: "x",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      }),
    /exactly one choice/
  );
  assert.throws(
    () =>
      convertAnthropicResponseToOpenAIChat({
        id: "x",
        type: "message",
        role: "assistant",
        content: [{ type: "server_tool_use", id: "srv_1", name: "web_search" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    ConversionError
  );
  assert.throws(
    () =>
      convertOpenAIChatResponseToAnthropic({
        id: "x",
        choices: [
          {
            message: { role: "assistant", content: "x" },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 1,
          total_tokens: 6,
          prompt_tokens_details: { cached_tokens: 8 },
        },
      }),
    /exceed prompt_tokens/
  );
  assert.throws(
    () => convertAnthropicResponseToOpenAIChat({
      id: "x",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      stop_reason: "end_turn",
      usage: { output_tokens: 1 },
    }),
    /Missing input_tokens/
  );
});

test("Anthropic SSE -> OpenAI buffers arbitrary chunks and preserves UTF-8, stop and usage", () => {
  const source =
    anthropicEvent("message_start", {
      type: "message_start",
      vendor_event_metadata: true,
      message: {
        id: "msg_stream",
        model: "claude-stream",
        vendor_message_metadata: true,
        usage: {
          input_tokens: 20,
          output_tokens: null,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          cache_creation: null,
          output_tokens_details: null,
          vendor_usage_metadata: true,
        },
      },
    }) +
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      vendor_event_metadata: true,
      content_block: { type: "text", text: "", vendor_block_metadata: true },
    }) +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      vendor_event_metadata: true,
      delta: { type: "text_delta", text: "你好", vendor_delta_metadata: true },
    }) +
    anthropicEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }) +
    anthropicEvent("message_delta", {
      type: "message_delta",
      vendor_event_metadata: true,
      delta: {
        stop_reason: "end_turn",
        stop_sequence: null,
        vendor_delta_metadata: true,
      },
      usage: { output_tokens: 3, vendor_usage_metadata: true },
    }) +
    anthropicEvent("message_stop", { type: "message_stop" });

  const converter = new AnthropicToOpenAIStreamConverter();
  const bytes = new TextEncoder().encode(source);
  let output = "";
  // Deliberately split inside JSON, CRLF boundaries and multi-byte Chinese text.
  for (let offset = 0; offset < bytes.length; offset += 7) {
    output += converter.feed(bytes.slice(offset, offset + 7));
  }
  output += converter.finish();
  const events = parseSse(output);
  assert.equal(events.at(-1)?.data, "[DONE]");
  const payloads = events
    .map((event) => event.data)
    .filter((data): data is Record<string, unknown> => typeof data === "object");
  const deltas = payloads
    .flatMap((payload) => payload.choices as Array<Record<string, unknown>>)
    .filter(Boolean)
    .map((choice) => choice.delta as Record<string, unknown>);
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "你好");
  const finish = payloads
    .flatMap((payload) => payload.choices as Array<Record<string, unknown>>)
    .find((choice) => choice?.finish_reason === "stop");
  assert.ok(finish);
  const usagePayload = payloads.find(
    (payload) => Array.isArray(payload.choices) && payload.choices.length === 0
  );
  assert.deepEqual(usagePayload?.usage, {
    prompt_tokens: 20,
    completion_tokens: 3,
    total_tokens: 23,
  });
});

test("Anthropic SSE -> OpenAI streams tool argument fragments with stable tool index", () => {
  const converter = new AnthropicToOpenAIStreamConverter();
  const fragments = [
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_tool",
        model: "claude",
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    }),
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "toolu_1", name: "sum", input: {} },
    }),
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"a":' },
    }),
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: "2}" },
    }),
    anthropicEvent("content_block_stop", {
      type: "content_block_stop",
      index: 1,
    }),
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "tool_use", stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    anthropicEvent("message_stop", { type: "message_stop" }),
  ];
  const output = fragments.map((fragment) => converter.feed(fragment)).join("");
  converter.finish();
  const toolDeltas = parseSse(output)
    .map((event) => event.data as Record<string, unknown>)
    .flatMap((payload) => (payload.choices as Array<Record<string, unknown>>) ?? [])
    .flatMap((choice) => {
      const delta = choice.delta as Record<string, unknown>;
      return (delta.tool_calls as Array<Record<string, unknown>>) ?? [];
    });
  assert.equal(toolDeltas.length, 3);
  assert.equal(toolDeltas[0].index, 0);
  assert.equal(toolDeltas[0].id, "toolu_1");
  assert.equal(toolDeltas.map((delta) => {
    const fn = delta.function as Record<string, unknown>;
    return fn.arguments ?? "";
  }).join(""), '{"a":2}');
});

test("Anthropic SSE -> OpenAI maps thinking deltas and ignores signatures and redacted thinking", () => {
  const converter = new AnthropicToOpenAIStreamConverter();
  const source =
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_thinking_stream",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    }) +
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "initial " },
    }) +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "reasoning" },
    }) +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "signature_delta", signature: "opaque-signature" },
    }) +
    anthropicEvent("content_block_stop", {
      type: "content_block_stop",
      index: 0,
    }) +
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 1,
      content_block: { type: "redacted_thinking", data: "opaque-redacted-data" },
    }) +
    anthropicEvent("content_block_stop", {
      type: "content_block_stop",
      index: 1,
    }) +
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 2,
      content_block: { type: "text", text: "" },
    }) +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 2,
      delta: { type: "text_delta", text: "answer" },
    }) +
    anthropicEvent("content_block_stop", {
      type: "content_block_stop",
      index: 2,
    }) +
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 5 },
    }) +
    anthropicEvent("message_stop", { type: "message_stop" });

  const output = converter.feed(source) + converter.finish();
  const deltas = parseSse(output)
    .map((event) => event.data)
    .filter((data): data is Record<string, unknown> => typeof data === "object")
    .flatMap((payload) => (payload.choices as Array<Record<string, unknown>>) ?? [])
    .map((choice) => choice.delta as Record<string, unknown>);

  assert.equal(
    deltas.map((delta) => delta.reasoning_content ?? "").join(""),
    "initial reasoning"
  );
  assert.equal(deltas.map((delta) => delta.content ?? "").join(""), "answer");
  assert.equal(output.includes("opaque-signature"), false);
  assert.equal(output.includes("opaque-redacted-data"), false);
});

test("Anthropic thinking SSE blocks keep strict delta and lifecycle validation", () => {
  const wrongDelta = new AnthropicToOpenAIStreamConverter();
  wrongDelta.feed(
    anthropicEvent("message_start", {
      type: "message_start",
      message: { id: "m", model: "claude", usage: {} },
    }) +
      anthropicEvent("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking", thinking: "" },
      })
  );
  assert.throws(
    () =>
      wrongDelta.feed(
        anthropicEvent("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "not-thinking" },
        })
      ),
    /does not match its content block/
  );

  const unstopped = new AnthropicToOpenAIStreamConverter();
  assert.throws(
    () =>
      unstopped.feed(
        anthropicEvent("message_start", {
          type: "message_start",
          message: { id: "m", model: "claude", usage: {} },
        }) +
          anthropicEvent("content_block_start", {
            type: "content_block_start",
            index: 0,
            content_block: { type: "thinking", thinking: "" },
          }) +
          anthropicEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
          }) +
          anthropicEvent("message_stop", { type: "message_stop" })
      ),
    /Content block 0 was not stopped/
  );
});

test("Anthropic SSE parser does not emit incomplete events and rejects truncated streams", () => {
  const converter = new AnthropicToOpenAIStreamConverter();
  assert.equal(
    converter.feed(
      'event: message_start\ndata: {"type":"message_start","message":{"id":"m"'
    ),
    ""
  );
  assert.throws(() => converter.finish(), ConversionError);
});

test("OpenAI SSE -> Anthropic converts text, finish and final cached usage", () => {
  const chunks = [
    openAIEvent({
      id: "chatcmpl_s",
      model: "gpt-s",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            reasoning_content: "provider-private reasoning",
            thinking: "provider-private thinking",
            tool_calls: null,
          },
          finish_reason: null,
        },
      ],
    }),
    openAIEvent({
      id: "chatcmpl_s",
      model: "gpt-s",
      choices: [{ index: 0, delta: { content: "hel" }, finish_reason: null }],
    }),
    openAIEvent({
      id: "chatcmpl_s",
      model: "gpt-s",
      choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }],
    }),
    openAIEvent({
      id: "chatcmpl_s",
      model: "gpt-s",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }),
    openAIEvent({
      id: "chatcmpl_s",
      model: "gpt-s",
      choices: [],
      usage: {
        prompt_tokens: 50,
        completion_tokens: 2,
        total_tokens: 52,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    }),
    "data: [DONE]\n\n",
  ].join("");
  const converter = new OpenAIToAnthropicStreamConverter();
  let output = "";
  for (let offset = 0; offset < chunks.length; offset += 11) {
    output += converter.feed(chunks.slice(offset, offset + 11));
  }
  output += converter.finish();
  const events = parseSse(output);
  assert.deepEqual(
    events.map((event) => event.event),
    [
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]
  );
  assert.equal(
    events
      .filter((event) => event.event === "content_block_delta")
      .map((event) => {
        const data = event.data as Record<string, unknown>;
        return (data.delta as Record<string, unknown>).text;
      })
      .join(""),
    "hello"
  );
  const finalDelta = events.find((event) => event.event === "message_delta")
    ?.data as Record<string, unknown>;
  assert.deepEqual(finalDelta.delta, {
    stop_reason: "end_turn",
    stop_sequence: null,
  });
  assert.deepEqual(finalDelta.usage, {
    input_tokens: 30,
    output_tokens: 2,
    cache_read_input_tokens: 20,
  });
});

test("OpenAI SSE -> Anthropic buffers fragmented parallel tool calls", () => {
  const converter = new OpenAIToAnthropicStreamConverter();
  const input = [
    openAIEvent({
      id: "chatcmpl_tools",
      model: "gpt",
      choices: [
        {
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_0",
                type: "function",
                function: { name: "alpha", arguments: '{"x":' },
              },
              {
                index: 1,
                id: "call_1",
                type: "function",
                function: { name: "beta", arguments: '{"y":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    openAIEvent({
      id: "chatcmpl_tools",
      model: "gpt",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: "2}" } },
              { index: 0, function: { arguments: "1}" } },
            ],
          },
          finish_reason: null,
        },
      ],
    }),
    openAIEvent({
      id: "chatcmpl_tools",
      model: "gpt",
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    }),
    "data: [DONE]\n\n",
  ].join("");
  // First feed deliberately leaves an SSE event incomplete.
  const firstCut = input.indexOf("call_1") + 3;
  assert.equal(converter.feed(input.slice(0, firstCut)), "");
  const output = converter.feed(input.slice(firstCut)) + converter.finish();
  const events = parseSse(output);
  const starts = events.filter((event) => event.event === "content_block_start");
  assert.deepEqual(
    starts.map((event) => {
      const data = event.data as Record<string, unknown>;
      const block = data.content_block as Record<string, unknown>;
      return [data.index, block.id, block.name];
    }),
    [
      [0, "call_0", "alpha"],
      [1, "call_1", "beta"],
    ]
  );
  const argumentDeltas = events
    .filter((event) => event.event === "content_block_delta")
    .map((event) => {
      const data = event.data as Record<string, unknown>;
      const delta = data.delta as Record<string, unknown>;
      return [data.index, delta.partial_json];
    });
  assert.deepEqual(argumentDeltas, [
    [0, '{"x":'],
    [1, '{"y":'],
    [1, "2}"],
    [0, "1}"],
  ]);
  const final = events.find((event) => event.event === "message_delta")
    ?.data as Record<string, unknown>;
  assert.deepEqual(final.delta, {
    stop_reason: "tool_use",
    stop_sequence: null,
  });
});

test("OpenAI SSE ignores unknown extensions and rejects invalid completed tool JSON", () => {
  const compatible = new OpenAIToAnthropicStreamConverter();
  const compatibleOutput =
    compatible.feed(
      openAIEvent({ choices: null, provider_metadata_only: true }) +
        openAIEvent({
          id: "x",
          model: "m",
          provider_response_metadata: true,
          choices: [
            {
              index: 0,
              provider_choice_metadata: true,
              delta: { provider_secret_field: "hidden" },
              finish_reason: null,
            },
          ],
        }) +
        openAIEvent({
          id: "x",
          model: "m",
          choices: [
            {
              index: 0,
              delta: {},
              finish_reason: "stop",
            },
          ],
        }) +
        "data: [DONE]\n\n"
    ) + compatible.finish();
  assert.match(compatibleOutput, /event: message_start/);
  assert.match(compatibleOutput, /event: message_stop/);
  assert.doesNotMatch(compatibleOutput, /provider_secret_field/);

  const invalidTool = new OpenAIToAnthropicStreamConverter();
  invalidTool.feed(
    openAIEvent({
      id: "x",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call",
                type: "function",
                function: { name: "bad", arguments: "{" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    })
  );
  assert.throws(
    () =>
      invalidTool.feed(
        openAIEvent({
          id: "x",
          model: "m",
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })
      ),
    /Invalid JSON/
  );
});

test("byte TransformStream factories pipe both SSE directions", async () => {
  const anthropicSource =
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_pipe",
        type: "message",
        role: "assistant",
        model: "claude",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    anthropicEvent("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }) +
    anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "ok" },
    }) +
    anthropicEvent("content_block_stop", { type: "content_block_stop", index: 0 }) +
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    anthropicEvent("message_stop", { type: "message_stop" });
  const antBytes = new TextEncoder().encode(anthropicSource);
  const antReadable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(antBytes.slice(0, 17));
      controller.enqueue(antBytes.slice(17));
      controller.close();
    },
  });
  const openAIOutput = await new Response(
    antReadable.pipeThrough(createAnthropicToOpenAIChatSseTransform())
  ).text();
  assert.match(openAIOutput, /"content":"ok"/);
  assert.match(openAIOutput, /data: \[DONE\]/);

  const openAISource =
    openAIEvent({
      id: "chatcmpl_pipe",
      model: "gpt",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    }) +
    openAIEvent({
      id: "chatcmpl_pipe",
      model: "gpt",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    }) +
    "data: [DONE]\n\n";
  const oaiBytes = new TextEncoder().encode(openAISource);
  const oaiReadable = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(oaiBytes.slice(0, 13));
      controller.enqueue(oaiBytes.slice(13));
      controller.close();
    },
  });
  const anthropicOutput = await new Response(
    oaiReadable.pipeThrough(createOpenAIChatToAnthropicSseTransform())
  ).text();
  assert.match(anthropicOutput, /event: message_start/);
  assert.match(anthropicOutput, /"text":"ok"/);
  assert.match(anthropicOutput, /event: message_stop/);
});

test("rejects oversized incomplete SSE events", () => {
  const converter = new AnthropicToOpenAIStreamConverter();
  assert.throws(
    () => converter.feed(`data: ${"x".repeat(1024 * 1024 + 1)}`),
    /1 MiB/
  );
  const complete = new AnthropicToOpenAIStreamConverter();
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

test("accepts a transport chunk over 1 MiB when every SSE event is small", () => {
  const pings = anthropicEvent("ping", { type: "ping" }).repeat(40_000);
  assert.ok(pings.length > 1024 * 1024);
  const terminal =
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_many_events",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    anthropicEvent("message_stop", { type: "message_stop" });
  const output = new AnthropicToOpenAIStreamConverter().feed(pings + terminal);
  assert.match(output, /data: \[DONE\]/);
});

test("rejects invalid UTF-8 split across SSE chunks", () => {
  const converter = new AnthropicToOpenAIStreamConverter();
  converter.feed(anthropicEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_utf8",
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      usage: { input_tokens: 1, output_tokens: 0 },
    },
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
    (error: unknown) => error instanceof ConversionError && /UTF-8/.test(error.message)
  );
});

test("requires explicit stream stop reasons but accepts EOF after a finish reason", () => {
  const anthropic = new AnthropicToOpenAIStreamConverter();
  assert.throws(
    () => anthropic.feed(
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          id: "msg_no_reason",
          type: "message",
          role: "assistant",
          model: "m",
          content: [],
          usage: { input_tokens: 1, output_tokens: 0 },
        },
      }) + anthropicEvent("message_stop", { type: "message_stop" })
    ),
    /stop_reason/
  );

  const openAI = new OpenAIToAnthropicStreamConverter();
  assert.throws(
    () => openAI.feed(
      openAIEvent({
        id: "chatcmpl_no_reason",
        model: "m",
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      }) + "data: [DONE]\n\n"
    ),
    /finish_reason/
  );

  const eof = new OpenAIToAnthropicStreamConverter();
  eof.feed(openAIEvent({
    id: "chatcmpl_eof",
    model: "m",
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }],
  }));
  assert.match(eof.finish(), /event: message_stop/);
});

test("rejects empty Chat and Anthropic SSE streams", () => {
  assert.throws(
    () => new AnthropicToOpenAIStreamConverter().finish(),
    /before message_start/
  );
  assert.throws(
    () => new OpenAIToAnthropicStreamConverter().finish(),
    /before any chat chunk/
  );
});

test("caps aggregate streamed tool arguments in both directions", () => {
  const fragment = "x".repeat(512 * 1024);
  const anthropic = new AnthropicToOpenAIStreamConverter();
  anthropic.feed(anthropicEvent("message_start", {
    type: "message_start",
    message: {
      id: "msg_total_args",
      type: "message",
      role: "assistant",
      model: "m",
      content: [],
      usage: {},
    },
  }));
  for (let index = 0; index < 16; index += 1) {
    anthropic.feed(anthropicEvent("content_block_start", {
      type: "content_block_start",
      index,
      content_block: { type: "tool_use", id: `tool_${index}`, name: "f", input: {} },
    }));
    for (let part = 0; part < 2; part += 1) {
      anthropic.feed(anthropicEvent("content_block_delta", {
        type: "content_block_delta",
        index,
        delta: { type: "input_json_delta", partial_json: fragment },
      }));
    }
  }
  anthropic.feed(anthropicEvent("content_block_start", {
    type: "content_block_start",
    index: 16,
    content_block: { type: "tool_use", id: "tool_16", name: "f", input: {} },
  }));
  assert.throws(
    () => anthropic.feed(anthropicEvent("content_block_delta", {
      type: "content_block_delta",
      index: 16,
      delta: { type: "input_json_delta", partial_json: "x" },
    })),
    /累计超过 16 MiB/
  );

  const openAI = new OpenAIToAnthropicStreamConverter();
  for (let index = 0; index < 16; index += 1) {
    openAI.feed(openAIEvent({
      id: "chatcmpl_total_args",
      model: "m",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index,
            id: `call_${index}`,
            type: "function",
            function: { name: "f", arguments: fragment },
          }],
        },
        finish_reason: null,
      }],
    }));
    openAI.feed(openAIEvent({
      id: "chatcmpl_total_args",
      model: "m",
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, function: { arguments: fragment } }] },
        finish_reason: null,
      }],
    }));
  }
  assert.throws(
    () => openAI.feed(openAIEvent({
      id: "chatcmpl_total_args",
      model: "m",
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: 16,
            id: "call_16",
            type: "function",
            function: { name: "f", arguments: "x" },
          }],
        },
        finish_reason: null,
      }],
    })),
    /累计超过 16 MiB/
  );
});

test("uses stateful Chat failure frames without appending after a delivered terminal", () => {
  const anthropicTerminal =
    anthropicEvent("message_start", {
      type: "message_start",
      message: {
        id: "msg_terminal",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }) +
    anthropicEvent("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }) +
    anthropicEvent("message_stop", { type: "message_stop" });

  const deliveredAnthropic = new AnthropicToOpenAIStreamConverter();
  assert.match(deliveredAnthropic.feed(anthropicTerminal), /data: \[DONE\]/);
  assert.throws(
    () => deliveredAnthropic.feed(anthropicEvent("ping", { type: "ping" })),
    /after message_stop/
  );
  assert.equal(deliveredAnthropic.failureFrame("too late"), "");

  const sameFeedAnthropic = new AnthropicToOpenAIStreamConverter();
  assert.throws(
    () => sameFeedAnthropic.feed(
      anthropicTerminal + anthropicEvent("ping", { type: "ping" })
    ),
    /after message_stop/
  );
  const openAIFailure = sameFeedAnthropic.failureFrame("bad tail");
  assert.match(openAIFailure, /route_conversion_error/);
  assert.match(openAIFailure, /data: \[DONE\]/);

  const openAITerminal =
    openAIEvent({
      id: "chatcmpl_terminal",
      model: "m",
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: "stop" }],
    }) + "data: [DONE]\n\n";
  const deliveredOpenAI = new OpenAIToAnthropicStreamConverter();
  assert.match(deliveredOpenAI.feed(openAITerminal), /event: message_stop/);
  assert.throws(
    () => deliveredOpenAI.feed(openAIEvent({
      id: "chatcmpl_terminal",
      model: "m",
      choices: [],
    })),
    /after \[DONE\]/
  );
  assert.equal(deliveredOpenAI.failureFrame("too late"), "");

  const sameFeedOpenAI = new OpenAIToAnthropicStreamConverter();
  assert.throws(
    () => sameFeedOpenAI.feed(
      openAITerminal + openAIEvent({
        id: "chatcmpl_terminal",
        model: "m",
        choices: [],
      })
    ),
    /after \[DONE\]/
  );
  const anthropicFailure = sameFeedOpenAI.failureFrame("bad tail");
  assert.match(anthropicFailure, /event: error/);
  assert.doesNotMatch(anthropicFailure, /event: message_stop/);
});
