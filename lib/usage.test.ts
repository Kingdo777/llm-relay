import assert from "node:assert/strict";
import test from "node:test";
import { extractTokenUsage } from "./usage";

test("extracts token usage from all non-stream response shapes", () => {
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
    })),
    { inputTokens: 12, outputTokens: 8, totalTokens: 20 }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({
      response: { usage: { input_tokens: 15, output_tokens: 5, total_tokens: 20 } },
    })),
    { inputTokens: 15, outputTokens: 5, totalTokens: 20 }
  );
  assert.deepEqual(
    extractTokenUsage(JSON.stringify({ usage: { input_tokens: 10, output_tokens: 7 } })),
    { inputTokens: 10, outputTokens: 7, totalTokens: 17 }
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
    { inputTokens: 27, outputTokens: 6, totalTokens: 33 }
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
  });
});
