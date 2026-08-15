import assert from "node:assert/strict";
import test from "node:test";
import { compactLogInput, parseLogInput, parseLogOutput } from "./log-parser";

test("does not fall back to historical text when the latest user message is a tool result", () => {
  const raw = JSON.stringify({
    system: "large system prompt",
    messages: [
      { role: "user", content: [{ type: "text", text: "<system-reminder>hidden context</system-reminder>" }, { type: "text", text: "older request" }] },
      { role: "assistant", content: "older answer" },
      { role: "user", content: [{ type: "tool_result", content: "large tool output" }] },
      { role: "user", content: [{ type: "text", text: "current request" }] },
      { role: "user", content: [{ type: "tool_result", content: "latest tool output" }] },
    ],
    tools: [{ name: "large tool schema" }],
  });
  const compacted = JSON.parse(compactLogInput(raw, 200_000));
  assert.deepEqual(compacted, { messages: [] });
});

test("keeps human text from the latest user message and removes system context", () => {
  const raw = JSON.stringify({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>hidden context</system-reminder>" },
        { type: "text", text: "current request" },
      ],
    }],
  });
  const compacted = JSON.parse(compactLogInput(raw, 200_000));
  assert.deepEqual(compacted, { messages: [{ role: "user", content: "current request" }] });
});

test("strips a leading system-reminder block but keeps the real user text (Claude Code style)", () => {
  const raw = JSON.stringify({
    messages: [{
      role: "user",
      content:
        "<system-reminder>\n注入的上下文\n</system-reminder>\n你好，帮我看看日志",
    }],
  });
  const compacted = JSON.parse(compactLogInput(raw, 200_000));
  assert.deepEqual(compacted, { messages: [{ role: "user", content: "你好，帮我看看日志" }] });
});

test("strips Claude Code local-command wrappers and keeps only the real user text", () => {
  const raw = JSON.stringify({
    messages: [{
      role: "user",
      content: [
        { type: "text", text: "<system-reminder>\n注入的上下文\n</system-reminder>" },
        { type: "text", text: "<local-command-caveat>Caveat: DO NOT respond to these messages.</local-command-caveat>\n" },
        { type: "text", text: "<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args></command-args>\n" },
        { type: "text", text: "<local-command-stdout>Set model to yibu-gpt-5.6-sol</local-command-stdout>\n" },
        { type: "text", text: "hi" },
      ],
    }],
  });
  const compacted = JSON.parse(compactLogInput(raw, 200_000));
  assert.deepEqual(compacted, { messages: [{ role: "user", content: "hi" }] });
});

test("keeps Anthropic single-object text content", () => {
  const raw = JSON.stringify({
    messages: [{ role: "user", content: { type: "text", text: "你好" } }],
  });
  const compacted = JSON.parse(compactLogInput(raw, 200_000));
  assert.deepEqual(compacted, { messages: [{ role: "user", content: "你好" }] });
});

test("returns empty when the latest user message is only injected context (no fallback)", () => {
  const raw = JSON.stringify({
    messages: [
      { role: "user", content: "older real question" },
      { role: "user", content: "<system-reminder>纯注入上下文</system-reminder>" },
    ],
  });
  const compacted = JSON.parse(compactLogInput(raw, 200_000));
  assert.deepEqual(compacted, { messages: [] });
});

test("parses Anthropic request messages", () => {
  const parsed = parseLogInput(JSON.stringify({ messages: [{ role: "user", content: [{ type: "text", text: "# Hello" }, { type: "tool_result", content: "done" }] }] }));
  assert.equal(parsed.entries[0].role, "user");
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "# Hello", format: "markdown" });
  assert.equal(parsed.entries[0].blocks[1].type, "tool");
});

test("recovers messages from a request truncated after the messages array", () => {
  const raw = '{"model":"x","messages":[{"role":"user","content":"visible request"}],"system":"unfinished';
  const parsed = parseLogInput(raw);
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "visible request", format: "markdown" });
});

test("recovers complete user messages from inside a truncated messages array", () => {
  const raw = '{"messages":[{"role":"user","content":[{"type":"text","text":"<system-reminder>hidden</system-reminder>"},{"type":"text","text":"human request"}]},{"role":"assistant","content":"answer"},{"role":"user","content":[{"type":"tool_result","content":"unfinished';
  const parsed = parseLogInput(raw);
  assert.equal(parsed.entries[0].role, "user");
  assert.equal(parsed.entries[0].blocks.length, 2);
  assert.equal(parsed.entries[0].blocks[1].type, "text");
  if (parsed.entries[0].blocks[1].type === "text") {
    assert.equal(parsed.entries[0].blocks[1].text, "human request");
  }
});

test("parses OpenAI non-stream response", () => {
  const parsed = parseLogOutput(JSON.stringify({ choices: [{ message: { role: "assistant", content: "**Done**", tool_calls: [{ function: { name: "save", arguments: '{"id":1}' } }] } }], usage: { output_tokens: 4 } }), "openai");
  assert.equal(parsed.entries[0].blocks[0].type, "text");
  assert.deepEqual(parsed.entries[0].blocks[1], { type: "tool", name: "save", input: { id: 1 } });
});

test("assembles OpenAI SSE text", () => {
  const raw = 'data: {"choices":[{"index":0,"delta":{"content":"Hello "}}]}\n\ndata: {"choices":[{"index":0,"delta":{"content":"world"}}]}\n\ndata: [DONE]\n\n';
  const parsed = parseLogOutput(raw, "openai");
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "Hello world", format: "markdown" });
  assert.deepEqual(parsed.warnings, []);
});

test("detects OpenAI SSE returned for an Anthropic request", () => {
  const raw = 'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"actual reply"}}]}\n\ndata: [DONE]\n\n';
  const parsed = parseLogOutput(raw, "anthropic");
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "actual reply", format: "markdown" });
});

test("parses OpenAI reasoning content when no final content is present", () => {
  const raw = 'data: {"choices":[{"index":0,"delta":{"reasoning_content":"working..."}}]}\n\ndata: [DONE]\n\n';
  const parsed = parseLogOutput(raw, "anthropic");
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "working...", format: "plain" });
});

test("detects OpenAI JSON returned for an Anthropic request", () => {
  const raw = JSON.stringify({ choices: [{ message: { role: "assistant", content: "reply" } }] });
  const parsed = parseLogOutput(raw, "anthropic");
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "reply", format: "markdown" });
});

test("assembles Anthropic SSE text and tool input", () => {
  const raw = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"# Result"}}',
    'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"read","input":{}}}',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a.md\\"}"}}',
    "",
  ].join("\n\n");
  const parsed = parseLogOutput(raw, "anthropic");
  assert.deepEqual(parsed.entries[0].blocks[0], { type: "text", text: "# Result", format: "markdown" });
  assert.deepEqual(parsed.entries[0].blocks[1], { type: "tool", name: "read", input: { path: "a.md" } });
});

test("keeps partial content when SSE is truncated", () => {
  const parsed = parseLogOutput('data: {"choices":[{"delta":{"content":"partial"}}]}', "openai");
  assert.equal(parsed.entries[0].blocks[0].type, "text");
  assert.match(parsed.warnings?.join(" ") ?? "", /截断/);
});

test("falls back for malformed payload", () => {
  const parsed = parseLogOutput("{broken", "anthropic");
  assert.equal(parsed.entries[0].blocks[0].type, "text");
  assert.ok(parsed.warnings?.length);
});
