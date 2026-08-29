import assert from "node:assert/strict";
import test from "node:test";
import { extractRecoverableTokenUsage, extractTokenUsage } from "./usage";

test("extracts token usage from all non-stream response shapes", () => {
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })),
    { inputTokens: 12, outputTokens: 8, totalTokens: 20, cachedInputTokens: null }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      response: { usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 } },
    })),
    { inputTokens: 15, outputTokens: 5, totalTokens: 20, cachedInputTokens: null }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 7 } })),
    { inputTokens: 10, outputTokens: 7, totalTokens: 17, cachedInputTokens: null }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      usage: {
        input_tokens: 4,
        cache_creation_input_tokens: 3,
        cache_read_input_tokens: 20,
        output_tokens: 6,
      },
    })),
    { inputTokens: 27, outputTokens: 6, totalTokens: 33, cachedInputTokens: 20 }
  );
});

test("extracts cached input tokens from OpenAI and Responses details", () => {
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      usage: {
        prompt_tokens: 100,
        completion_tokens: 8,
        total_tokens: 108,
        prompt_tokens_details: { cached_tokens: 64 },
      },
    })),
    { inputTokens: 100, outputTokens: 8, totalTokens: 108, cachedInputTokens: 64 }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      response: {
        usage: {
          input_tokens: 120,
          output_tokens: 10,
          total_tokens: 130,
          input_tokens_details: { cached_tokens: 80 },
        },
      },
    })),
    { inputTokens: 120, outputTokens: 10, totalTokens: 130, cachedInputTokens: 80 }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      usage: {
        prompt_tokens: 5,
        completion_tokens: 1,
        prompt_tokens_details: { cached_tokens: 0 },
      },
    })),
    { inputTokens: 5, outputTokens: 1, totalTokens: 6, cachedInputTokens: 0 }
  );
});

test("uses CodeAgent OpenAI billing usage without double-counting cache", () => {
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      usage: {
        input_tokens: 208,
        cache_read_input_tokens: 43,
        output_tokens: 23,
        billing_usage: {
          semantic: "openai",
          openai_usage: {
            prompt_tokens: 208,
            completion_tokens: 23,
            total_tokens: 231,
            prompt_tokens_details: { cached_tokens: 43 },
          },
        },
      },
    })),
    { inputTokens: 208, outputTokens: 23, totalTokens: 231, cachedInputTokens: 43 }
  );
});

test("merges Anthropic usage across SSE events", () => {
  const raw = [
    "event: message_start",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":21,"output_tokens":1}}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","usage":{"output_tokens":13}}',
    "",
  ].join("\n");
  assert.deepEqual(extractTokenUsage(raw), {
    inputTokens: 21,
    outputTokens: 13,
    totalTokens: 34,
    cachedInputTokens: null,
  });
});

test("merges Anthropic cached usage across SSE events without summing", () => {
  const raw = [
    "event: message_start",
    'data: {"type":"message_start","message":{"usage":{"input_tokens":4,"cache_creation_input_tokens":3,"cache_read_input_tokens":20,"output_tokens":1}}}',
    "",
    "event: message_delta",
    'data: {"type":"message_delta","usage":{"output_tokens":13}}',
    "",
  ].join("\n");
  assert.deepEqual(extractTokenUsage(raw), {
    inputTokens: 27,
    outputTokens: 13,
    totalTokens: 40,
    cachedInputTokens: 20,
  });
});

test("extracts usage from an OpenAI streaming usage chunk", () => {
  const raw = [
    'data: {"choices":[{"delta":{"content":"hi"}}],"usage":null}',
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12}}',
    "data: [DONE]",
  ].join("\n\n");
  assert.deepEqual(extractTokenUsage(raw), {
    inputTokens: 9,
    outputTokens: 3,
    totalTokens: 12,
    cachedInputTokens: null,
  });
});

test("extracts cached tokens from streaming OpenAI and Responses events", () => {
  const chat = [
    'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":6}}}',
    "data: [DONE]",
  ].join("\n\n");
  assert.equal(extractTokenUsage(chat)?.cachedInputTokens, 6);

  const responses = [
    'data: {"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":5,"total_tokens":35,"input_tokens_details":{"cached_tokens":24}}}}',
  ].join("\n\n");
  assert.deepEqual(extractTokenUsage(responses), {
    inputTokens: 30,
    outputTokens: 5,
    totalTokens: 35,
    cachedInputTokens: 24,
  });
});

test("does not backfill incomplete usage from truncated historical streams", () => {
  const truncatedAnthropic = [
    'data: {"type":"message_start","message":{"usage":{"input_tokens":33,"cache_read_input_tokens":0,"output_tokens":0}}}',
    "…[已截断，原始长度 250000]",
  ].join("\n");
  assert.equal(extractRecoverableTokenUsage(truncatedAnthropic), null);

  const completedResponses = [
    'data: {"type":"response.output_text.delta","delta":"正文里出现 …[已截断，原始长度 10] 字样"}',
    'data: {"type": "response.completed", "response":{"usage":{"input_tokens":30,"output_tokens":5,"total_tokens":35,"input_tokens_details":{"cached_tokens":24}}}}',
  ].join("\n");
  assert.equal(
    extractRecoverableTokenUsage(completedResponses)?.cachedInputTokens,
    24
  );

  const clampedAfterCompleted = [
    completedResponses,
    "…[已截断，原始长度 250000]",
  ].join("\n");
  assert.equal(extractRecoverableTokenUsage(clampedAfterCompleted), null);
});
