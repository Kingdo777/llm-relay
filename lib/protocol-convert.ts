/**
 * OpenAI Chat Completions <-> Anthropic Messages conversion.
 *
 * This module intentionally fails closed. A field that changes model behaviour
 * must either be mapped here or cause ConversionError; it is never silently
 * discarded. Harmless response metadata (timestamps, fingerprints, etc.) is
 * allowed where noted below.
 */

export type JsonObject = Record<string, unknown>;

export type ConversionDirection =
  | "openai-to-anthropic"
  | "anthropic-to-openai";

export class ConversionError extends Error {
  readonly code = "PROTOCOL_CONVERSION_ERROR";
  readonly status = 422;
  readonly field: string;

  constructor(
    message: string,
    readonly direction: ConversionDirection,
    readonly path = "$"
  ) {
    super(`${message} (${path})`);
    this.name = "ConversionError";
    this.field = path;
  }
}

const OAI_TO_ANT: ConversionDirection = "openai-to-anthropic";
const ANT_TO_OAI: ConversionDirection = "anthropic-to-openai";
const MAX_SSE_BUFFER = 1024 * 1024;
const MAX_STREAM_BLOCKS = 256;
const MAX_TOOL_ARGUMENTS = 1024 * 1024;
const MAX_TOTAL_TOOL_ARGUMENTS = 16 * 1024 * 1024;

function fail(
  direction: ConversionDirection,
  path: string,
  message: string
): never {
  throw new ConversionError(message, direction, path);
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function objectAt(
  value: unknown,
  direction: ConversionDirection,
  path: string
): JsonObject {
  if (!isObject(value)) fail(direction, path, "Expected an object");
  return value;
}

function arrayAt(
  value: unknown,
  direction: ConversionDirection,
  path: string
): unknown[] {
  if (!Array.isArray(value)) fail(direction, path, "Expected an array");
  return value;
}

function stringAt(
  value: unknown,
  direction: ConversionDirection,
  path: string,
  allowEmpty = true
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(direction, path, allowEmpty ? "Expected a string" : "Expected a non-empty string");
  }
  return value;
}

function booleanAt(
  value: unknown,
  direction: ConversionDirection,
  path: string
): boolean {
  if (typeof value !== "boolean") fail(direction, path, "Expected a boolean");
  return value;
}

function numberAt(
  value: unknown,
  direction: ConversionDirection,
  path: string,
  options: { integer?: boolean; positive?: boolean; nonNegative?: boolean } = {}
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(direction, path, "Expected a finite number");
  }
  if (options.integer && !Number.isInteger(value)) {
    fail(direction, path, "Expected an integer");
  }
  if (options.positive && value <= 0) {
    fail(direction, path, "Expected a positive number");
  }
  if (options.nonNegative && value < 0) {
    fail(direction, path, "Expected a non-negative number");
  }
  return value;
}

function assertAllowedKeys(
  value: JsonObject,
  allowed: readonly string[],
  direction: ConversionDirection,
  path: string
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(direction, `${path}.${key}`, `Unsupported field \"${key}\"`);
    }
  }
}

function parseJsonObject(
  text: string,
  direction: ConversionDirection,
  path: string
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    fail(
      direction,
      path,
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  return objectAt(parsed, direction, path);
}

function stringifyToolInput(
  value: unknown,
  direction: ConversionDirection,
  path: string
): string {
  const input = objectAt(value, direction, path);
  try {
    return JSON.stringify(input);
  } catch (error) {
    fail(
      direction,
      path,
      `Tool input is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function parseToolArguments(
  value: unknown,
  direction: ConversionDirection,
  path: string
): JsonObject {
  const text = stringAt(value, direction, path);
  if (text.trim() === "") return {};
  return parseJsonObject(text, direction, path);
}

/**
 * Anthropic exposes explicit ephemeral prompt-cache breakpoints while OpenAI
 * Chat caching is automatic. Validate the known hint before consuming it so a
 * malformed or future cache mode is not silently ignored.
 */
function consumeAnthropicCacheControl(value: unknown, path: string): void {
  if (value === undefined || value === null) return;
  const cache = objectAt(value, ANT_TO_OAI, path);
  assertAllowedKeys(cache, ["type", "ttl"], ANT_TO_OAI, path);
  if (cache.type !== "ephemeral") {
    fail(ANT_TO_OAI, `${path}.type`, `Unsupported cache type \"${String(cache.type)}\"`);
  }
  if (cache.ttl !== undefined && cache.ttl !== "5m" && cache.ttl !== "1h") {
    fail(ANT_TO_OAI, `${path}.ttl`, `Unsupported cache TTL \"${String(cache.ttl)}\"`);
  }
  fail(
    ANT_TO_OAI,
    path,
    "Anthropic cache_control 在 OpenAI Chat 中没有等价语义"
  );
}

function textFromOpenAIContent(
  value: unknown,
  direction: ConversionDirection,
  path: string,
  allowNull = false
): string {
  if ((value === null || value === undefined) && allowNull) return "";
  if (typeof value === "string") return value;
  const blocks = arrayAt(value, direction, path);
  return blocks
    .map((rawBlock, index) => {
      const blockPath = `${path}[${index}]`;
      const block = objectAt(rawBlock, direction, blockPath);
      assertAllowedKeys(block, ["type", "text"], direction, blockPath);
      if (block.type !== "text") {
        fail(
          direction,
          `${blockPath}.type`,
          `Unsupported OpenAI content block type \"${String(block.type)}\"`
        );
      }
      return stringAt(block.text, direction, `${blockPath}.text`);
    })
    .join("");
}

function textFromAnthropicBlocks(
  value: unknown,
  direction: ConversionDirection,
  path: string
): string {
  if (typeof value === "string") return value;
  const blocks = arrayAt(value, direction, path);
  return blocks
    .map((rawBlock, index) => {
      const blockPath = `${path}[${index}]`;
      const block = objectAt(rawBlock, direction, blockPath);
      assertAllowedKeys(block, ["type", "text", "cache_control"], direction, blockPath);
      if (block.type !== "text") {
        fail(
          direction,
          `${blockPath}.type`,
          `Unsupported Anthropic text block type \"${String(block.type)}\"`
        );
      }
      consumeAnthropicCacheControl(block.cache_control, `${blockPath}.cache_control`);
      return stringAt(block.text, direction, `${blockPath}.text`);
    })
    .join("");
}

function anthropicToolResultText(
  value: unknown,
  direction: ConversionDirection,
  path: string
): string {
  if (typeof value === "string") return value;
  const blocks = arrayAt(value, direction, path);
  return blocks
    .map((rawBlock, index) => {
      const blockPath = `${path}[${index}]`;
      const block = objectAt(rawBlock, direction, blockPath);
      assertAllowedKeys(block, ["type", "text", "cache_control"], direction, blockPath);
      if (block.type !== "text") {
        fail(
          direction,
          `${blockPath}.type`,
          `Unsupported tool result block type \"${String(block.type)}\"`
        );
      }
      consumeAnthropicCacheControl(block.cache_control, `${blockPath}.cache_control`);
      return stringAt(block.text, direction, `${blockPath}.text`);
    })
    .join("");
}

function appendAnthropicMessage(
  messages: JsonObject[],
  role: "user" | "assistant",
  blocks: JsonObject[]
): void {
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    (previous.content as unknown[]).push(...blocks);
    return;
  }
  messages.push({ role, content: blocks });
}

function appendAnthropicToolResult(
  messages: JsonObject[],
  block: JsonObject
): void {
  const previous = messages.at(-1);
  const previousBlocks = Array.isArray(previous?.content)
    ? (previous.content as JsonObject[])
    : null;
  // Anthropic requires tool_result blocks to precede text in a user turn.
  if (
    previous?.role === "user" &&
    previousBlocks !== null &&
    previousBlocks.every((item) => item.type === "tool_result")
  ) {
    previousBlocks.push(block);
    return;
  }
  if (previous?.role === "user") {
    fail(
      OAI_TO_ANT,
      "$request.messages",
      "tool 结果不能跟在同一 Anthropic user turn 的文本之后"
    );
  }
  messages.push({ role: "user", content: [block] });
}

function compactAnthropicMessageContent(message: JsonObject): JsonObject {
  const blocks = message.content as JsonObject[];
  if (blocks.length === 1 && blocks[0].type === "text") {
    return { ...message, content: blocks[0].text };
  }
  return message;
}

/** Convert an OpenAI Chat Completions request object to Anthropic Messages. */
export function convertOpenAIChatRequestToAnthropic(value: unknown): JsonObject {
  const body = objectAt(value, OAI_TO_ANT, "$request");
  assertAllowedKeys(
    body,
    [
      "model",
      "messages",
      "max_tokens",
      "max_completion_tokens",
      "temperature",
      "top_p",
      "stop",
      "stream",
      "stream_options",
      "tools",
      "tool_choice",
      "parallel_tool_calls",
      "user",
    ],
    OAI_TO_ANT,
    "$request"
  );

  const out: JsonObject = {
    model: stringAt(body.model, OAI_TO_ANT, "$request.model", false),
  };

  const oldMax = body.max_tokens;
  const newMax = body.max_completion_tokens;
  if (oldMax !== undefined && newMax !== undefined && oldMax !== newMax) {
    fail(
      OAI_TO_ANT,
      "$request.max_completion_tokens",
      "max_tokens and max_completion_tokens disagree"
    );
  }
  out.max_tokens =
    oldMax !== undefined
      ? numberAt(oldMax, OAI_TO_ANT, "$request.max_tokens", {
          integer: true,
          positive: true,
        })
      : newMax !== undefined
        ? numberAt(newMax, OAI_TO_ANT, "$request.max_completion_tokens", {
            integer: true,
            positive: true,
          })
        : 1024;

  for (const key of ["temperature", "top_p"] as const) {
    if (body[key] !== undefined) {
      out[key] = numberAt(body[key], OAI_TO_ANT, `$request.${key}`);
    }
  }
  if (body.stream !== undefined) {
    out.stream = booleanAt(body.stream, OAI_TO_ANT, "$request.stream");
  }
  if (body.stream_options !== undefined) {
    const options = objectAt(
      body.stream_options,
      OAI_TO_ANT,
      "$request.stream_options"
    );
    assertAllowedKeys(options, ["include_usage"], OAI_TO_ANT, "$request.stream_options");
    if (options.include_usage !== undefined) {
      booleanAt(
        options.include_usage,
        OAI_TO_ANT,
        "$request.stream_options.include_usage"
      );
    }
  }
  if (body.stop !== undefined && body.stop !== null) {
    out.stop_sequences =
      typeof body.stop === "string"
        ? [body.stop]
        : arrayAt(body.stop, OAI_TO_ANT, "$request.stop").map((item, index) =>
            stringAt(item, OAI_TO_ANT, `$request.stop[${index}]`)
          );
  }

  const systemParts: string[] = [];
  const anthropicMessages: JsonObject[] = [];
  const messages = arrayAt(body.messages, OAI_TO_ANT, "$request.messages");
  messages.forEach((rawMessage, messageIndex) => {
    const path = `$request.messages[${messageIndex}]`;
    const message = objectAt(rawMessage, OAI_TO_ANT, path);
    assertAllowedKeys(
      message,
      ["role", "content", "tool_calls", "tool_call_id", "name", "refusal"],
      OAI_TO_ANT,
      path
    );
    const role = stringAt(message.role, OAI_TO_ANT, `${path}.role`, false);
    if (message.refusal !== undefined && message.refusal !== null && message.refusal !== "") {
      fail(OAI_TO_ANT, `${path}.refusal`, "OpenAI refusal content has no Anthropic request equivalent");
    }

    if (role === "system") {
      if (message.tool_calls !== undefined || message.tool_call_id !== undefined) {
        fail(OAI_TO_ANT, path, "A system message cannot contain tool fields");
      }
      if (message.name !== undefined) {
        fail(OAI_TO_ANT, `${path}.name`, "Named system messages have no Anthropic equivalent");
      }
      systemParts.push(textFromOpenAIContent(message.content, OAI_TO_ANT, `${path}.content`));
      return;
    }

    if (role === "tool") {
      const toolUseId = stringAt(
        message.tool_call_id,
        OAI_TO_ANT,
        `${path}.tool_call_id`,
        false
      );
      if (message.tool_calls !== undefined) {
        fail(OAI_TO_ANT, `${path}.tool_calls`, "A tool result cannot contain tool_calls");
      }
      appendAnthropicToolResult(anthropicMessages, {
        type: "tool_result",
        tool_use_id: toolUseId,
        content: textFromOpenAIContent(
          message.content,
          OAI_TO_ANT,
          `${path}.content`
        ),
      });
      return;
    }

    if (role !== "user" && role !== "assistant") {
      fail(OAI_TO_ANT, `${path}.role`, `Unsupported OpenAI message role \"${role}\"`);
    }
    if (message.tool_call_id !== undefined || message.name !== undefined) {
      fail(OAI_TO_ANT, path, `Unsupported fields for role \"${role}\"`);
    }

    const blocks: JsonObject[] = [];
    const text = textFromOpenAIContent(
      message.content,
      OAI_TO_ANT,
      `${path}.content`,
      role === "assistant"
    );
    if (text !== "" || role === "user") blocks.push({ type: "text", text });

    if (message.tool_calls !== undefined) {
      if (role !== "assistant") {
        fail(OAI_TO_ANT, `${path}.tool_calls`, "Only assistant messages may contain tool_calls");
      }
      arrayAt(message.tool_calls, OAI_TO_ANT, `${path}.tool_calls`).forEach(
        (rawCall, callIndex) => {
          const callPath = `${path}.tool_calls[${callIndex}]`;
          const call = objectAt(rawCall, OAI_TO_ANT, callPath);
          assertAllowedKeys(call, ["id", "type", "function"], OAI_TO_ANT, callPath);
          if (call.type !== "function") {
            fail(OAI_TO_ANT, `${callPath}.type`, "Only function tool calls are supported");
          }
          const fn = objectAt(call.function, OAI_TO_ANT, `${callPath}.function`);
          assertAllowedKeys(fn, ["name", "arguments"], OAI_TO_ANT, `${callPath}.function`);
          blocks.push({
            type: "tool_use",
            id: stringAt(call.id, OAI_TO_ANT, `${callPath}.id`, false),
            name: stringAt(fn.name, OAI_TO_ANT, `${callPath}.function.name`, false),
            input: parseToolArguments(
              fn.arguments,
              OAI_TO_ANT,
              `${callPath}.function.arguments`
            ),
          });
        }
      );
    }
    if (blocks.length === 0) blocks.push({ type: "text", text: "" });
    appendAnthropicMessage(anthropicMessages, role, blocks);
  });
  if (systemParts.length > 0) out.system = systemParts.join("\n\n");
  out.messages = anthropicMessages.map(compactAnthropicMessageContent);

  if (body.tools !== undefined) {
    out.tools = arrayAt(body.tools, OAI_TO_ANT, "$request.tools").map(
      (rawTool, index) => {
        const path = `$request.tools[${index}]`;
        const tool = objectAt(rawTool, OAI_TO_ANT, path);
        assertAllowedKeys(tool, ["type", "function"], OAI_TO_ANT, path);
        if (tool.type !== "function") {
          fail(OAI_TO_ANT, `${path}.type`, "Only function tools are supported");
        }
        const fn = objectAt(tool.function, OAI_TO_ANT, `${path}.function`);
        assertAllowedKeys(
          fn,
          ["name", "description", "parameters", "strict"],
          OAI_TO_ANT,
          `${path}.function`
        );
        const converted: JsonObject = {
          name: stringAt(fn.name, OAI_TO_ANT, `${path}.function.name`, false),
          input_schema:
            fn.parameters === undefined
              ? { type: "object", properties: {} }
              : objectAt(fn.parameters, OAI_TO_ANT, `${path}.function.parameters`),
        };
        if (fn.description !== undefined) {
          converted.description = stringAt(
            fn.description,
            OAI_TO_ANT,
            `${path}.function.description`
          );
        }
        if (fn.strict !== undefined) {
          converted.strict = booleanAt(
            fn.strict,
            OAI_TO_ANT,
            `${path}.function.strict`
          );
        }
        return converted;
      }
    );
  }

  let toolChoice: JsonObject | undefined;
  let toolsDisabled = false;
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    if (typeof body.tool_choice === "string") {
      if (body.tool_choice === "auto") toolChoice = { type: "auto" };
      else if (body.tool_choice === "required") toolChoice = { type: "any" };
      else if (body.tool_choice === "none") {
        delete out.tools;
        toolsDisabled = true;
      } else {
        fail(OAI_TO_ANT, "$request.tool_choice", `Unsupported tool_choice \"${body.tool_choice}\"`);
      }
    } else {
      const choice = objectAt(body.tool_choice, OAI_TO_ANT, "$request.tool_choice");
      assertAllowedKeys(choice, ["type", "function"], OAI_TO_ANT, "$request.tool_choice");
      if (choice.type !== "function") {
        fail(OAI_TO_ANT, "$request.tool_choice.type", "Only function tool_choice is supported");
      }
      const fn = objectAt(choice.function, OAI_TO_ANT, "$request.tool_choice.function");
      assertAllowedKeys(fn, ["name"], OAI_TO_ANT, "$request.tool_choice.function");
      toolChoice = {
        type: "tool",
        name: stringAt(fn.name, OAI_TO_ANT, "$request.tool_choice.function.name", false),
      };
    }
  }
  if (body.parallel_tool_calls !== undefined) {
    const parallel = booleanAt(
      body.parallel_tool_calls,
      OAI_TO_ANT,
      "$request.parallel_tool_calls"
    );
    if (!toolsDisabled) {
      if (!toolChoice) toolChoice = { type: "auto" };
      toolChoice.disable_parallel_tool_use = !parallel;
    }
  }
  if (toolChoice) out.tool_choice = toolChoice;

  if (body.user !== undefined) {
    out.metadata = {
      user_id: stringAt(body.user, OAI_TO_ANT, "$request.user", false),
    };
  }
  return out;
}

/** Convert an Anthropic Messages request object to OpenAI Chat Completions. */
export function convertAnthropicRequestToOpenAIChat(value: unknown): JsonObject {
  const body = objectAt(value, ANT_TO_OAI, "$request");
  assertAllowedKeys(
    body,
    [
      "model",
      "messages",
      "system",
      "max_tokens",
      "temperature",
      "top_p",
      "stop_sequences",
      "stream",
      "tools",
      "tool_choice",
      "metadata",
      // Anthropic 扩展思考配置在 Chat 中没有稳定等价项；兼容路由时忽略。
      "thinking",
      // 部分 Anthropic 兼容客户端附带的追踪元数据，不影响生成语义；
      // OpenAI Chat 没有对应字段，按兼容约定安全忽略。
      "request_timestamp",
      "created_timestamp",
    ],
    ANT_TO_OAI,
    "$request"
  );
  const out: JsonObject = {
    model: stringAt(body.model, ANT_TO_OAI, "$request.model", false),
    max_tokens: numberAt(body.max_tokens, ANT_TO_OAI, "$request.max_tokens", {
      integer: true,
      positive: true,
    }),
    // Anthropic 与 OpenAI 都把省略 stream 解释为非流式。显式发送 false，
    // 避免部分兼容上游在字段缺失时错误地默认返回 SSE。
    stream: false,
  };
  for (const key of ["temperature", "top_p"] as const) {
    if (body[key] !== undefined) {
      out[key] = numberAt(body[key], ANT_TO_OAI, `$request.${key}`);
    }
  }
  if (body.stream !== undefined) {
    out.stream = booleanAt(body.stream, ANT_TO_OAI, "$request.stream");
    if (out.stream) out.stream_options = { include_usage: true };
  }
  if (body.stop_sequences !== undefined) {
    const stops = arrayAt(body.stop_sequences, ANT_TO_OAI, "$request.stop_sequences").map(
      (item, index) => stringAt(item, ANT_TO_OAI, `$request.stop_sequences[${index}]`)
    );
    out.stop = stops.length === 1 ? stops[0] : stops;
  }

  const messages: JsonObject[] = [];
  if (body.system !== undefined) {
    messages.push({
      role: "system",
      content: textFromAnthropicBlocks(body.system, ANT_TO_OAI, "$request.system"),
    });
  }
  arrayAt(body.messages, ANT_TO_OAI, "$request.messages").forEach(
    (rawMessage, messageIndex) => {
      const path = `$request.messages[${messageIndex}]`;
      const message = objectAt(rawMessage, ANT_TO_OAI, path);
      assertAllowedKeys(message, ["role", "content"], ANT_TO_OAI, path);
      const role = stringAt(message.role, ANT_TO_OAI, `${path}.role`, false);
      if (role !== "user" && role !== "assistant") {
        fail(ANT_TO_OAI, `${path}.role`, `Unsupported Anthropic message role \"${role}\"`);
      }
      if (typeof message.content === "string") {
        messages.push({ role, content: message.content });
        return;
      }
      const blocks = arrayAt(message.content, ANT_TO_OAI, `${path}.content`);
      if (role === "assistant") {
        const text: string[] = [];
        const toolCalls: JsonObject[] = [];
        blocks.forEach((rawBlock, blockIndex) => {
          const blockPath = `${path}.content[${blockIndex}]`;
          const block = objectAt(rawBlock, ANT_TO_OAI, blockPath);
          if (block.type === "text") {
            assertAllowedKeys(
              block,
              ["type", "text", "cache_control"],
              ANT_TO_OAI,
              blockPath
            );
            consumeAnthropicCacheControl(block.cache_control, `${blockPath}.cache_control`);
            text.push(stringAt(block.text, ANT_TO_OAI, `${blockPath}.text`));
          } else if (block.type === "tool_use") {
            assertAllowedKeys(
              block,
              ["type", "id", "name", "input", "cache_control"],
              ANT_TO_OAI,
              blockPath
            );
            consumeAnthropicCacheControl(block.cache_control, `${blockPath}.cache_control`);
            toolCalls.push({
              id: stringAt(block.id, ANT_TO_OAI, `${blockPath}.id`, false),
              type: "function",
              function: {
                name: stringAt(block.name, ANT_TO_OAI, `${blockPath}.name`, false),
                arguments: stringifyToolInput(
                  block.input,
                  ANT_TO_OAI,
                  `${blockPath}.input`
                ),
              },
            });
          } else {
            fail(
              ANT_TO_OAI,
              `${blockPath}.type`,
              `Unsupported Anthropic assistant block type \"${String(block.type)}\"`
            );
          }
        });
        const converted: JsonObject = {
          role: "assistant",
          content: text.length > 0 ? text.join("") : null,
        };
        if (toolCalls.length > 0) converted.tool_calls = toolCalls;
        messages.push(converted);
        return;
      }

      const messageCountBefore = messages.length;
      let pendingText = "";
      let sawText = false;
      const flushText = () => {
        if (pendingText !== "") {
          messages.push({ role: "user", content: pendingText });
          pendingText = "";
        }
      };
      blocks.forEach((rawBlock, blockIndex) => {
        const blockPath = `${path}.content[${blockIndex}]`;
        const block = objectAt(rawBlock, ANT_TO_OAI, blockPath);
        if (block.type === "text") {
          assertAllowedKeys(
            block,
            ["type", "text", "cache_control"],
            ANT_TO_OAI,
            blockPath
          );
          consumeAnthropicCacheControl(block.cache_control, `${blockPath}.cache_control`);
          const blockText = stringAt(block.text, ANT_TO_OAI, `${blockPath}.text`);
          pendingText += blockText;
          if (blockText !== "") sawText = true;
          return;
        }
        if (block.type === "tool_result") {
          assertAllowedKeys(
            block,
            ["type", "tool_use_id", "content", "is_error", "cache_control"],
            ANT_TO_OAI,
            blockPath
          );
          if (block.is_error !== undefined) {
            const isError = booleanAt(
              block.is_error,
              ANT_TO_OAI,
              `${blockPath}.is_error`
            );
            if (isError) {
              fail(
                ANT_TO_OAI,
                `${blockPath}.is_error`,
                "OpenAI Chat 无法无损表达 Anthropic 错误工具结果"
              );
            }
          }
          consumeAnthropicCacheControl(block.cache_control, `${blockPath}.cache_control`);
          if (sawText) {
            fail(
              ANT_TO_OAI,
              blockPath,
              "Anthropic tool_result blocks must precede text in a user message"
            );
          }
          flushText();
          messages.push({
            role: "tool",
            tool_call_id: stringAt(
              block.tool_use_id,
              ANT_TO_OAI,
              `${blockPath}.tool_use_id`,
              false
            ),
            content: anthropicToolResultText(
              block.content,
              ANT_TO_OAI,
              `${blockPath}.content`
            ),
          });
          return;
        }
        fail(
          ANT_TO_OAI,
          `${blockPath}.type`,
          `Unsupported Anthropic user block type \"${String(block.type)}\"`
        );
      });
      flushText();
      if (blocks.length === 0 || messages.length === messageCountBefore) {
        messages.push({ role: "user", content: "" });
      }
    }
  );
  out.messages = messages;

  if (body.tools !== undefined) {
    out.tools = arrayAt(body.tools, ANT_TO_OAI, "$request.tools").map(
      (rawTool, index) => {
        const path = `$request.tools[${index}]`;
        const tool = objectAt(rawTool, ANT_TO_OAI, path);
        assertAllowedKeys(
          tool,
          ["name", "description", "input_schema", "strict", "cache_control"],
          ANT_TO_OAI,
          path
        );
        consumeAnthropicCacheControl(tool.cache_control, `${path}.cache_control`);
        const fn: JsonObject = {
          name: stringAt(tool.name, ANT_TO_OAI, `${path}.name`, false),
          parameters:
            tool.input_schema === undefined
              ? { type: "object", properties: {} }
              : objectAt(tool.input_schema, ANT_TO_OAI, `${path}.input_schema`),
        };
        if (tool.description !== undefined) {
          fn.description = stringAt(tool.description, ANT_TO_OAI, `${path}.description`);
        }
        if (tool.strict !== undefined) {
          fn.strict = booleanAt(tool.strict, ANT_TO_OAI, `${path}.strict`);
        }
        return { type: "function", function: fn };
      }
    );
  }

  if (body.tool_choice !== undefined) {
    const choice = objectAt(body.tool_choice, ANT_TO_OAI, "$request.tool_choice");
    assertAllowedKeys(
      choice,
      ["type", "name", "disable_parallel_tool_use"],
      ANT_TO_OAI,
      "$request.tool_choice"
    );
    const type = stringAt(choice.type, ANT_TO_OAI, "$request.tool_choice.type", false);
    if (type === "auto") out.tool_choice = "auto";
    else if (type === "any") out.tool_choice = "required";
    else if (type === "tool") {
      out.tool_choice = {
        type: "function",
        function: {
          name: stringAt(choice.name, ANT_TO_OAI, "$request.tool_choice.name", false),
        },
      };
    } else if (type === "none") out.tool_choice = "none";
    else fail(ANT_TO_OAI, "$request.tool_choice.type", `Unsupported tool_choice \"${type}\"`);
    if (choice.disable_parallel_tool_use !== undefined) {
      out.parallel_tool_calls = !booleanAt(
        choice.disable_parallel_tool_use,
        ANT_TO_OAI,
        "$request.tool_choice.disable_parallel_tool_use"
      );
    }
  }

  if (body.metadata !== undefined) {
    const metadata = objectAt(body.metadata, ANT_TO_OAI, "$request.metadata");
    assertAllowedKeys(metadata, ["user_id"], ANT_TO_OAI, "$request.metadata");
    if (metadata.user_id !== undefined) {
      out.user = stringAt(metadata.user_id, ANT_TO_OAI, "$request.metadata.user_id", false);
    }
  }
  return out;
}

function mapAnthropicStopReason(
  value: unknown,
  path: string,
  allowNull = false
): string | null {
  if (value === null && allowNull) return null;
  const reason = stringAt(value, ANT_TO_OAI, path, false);
  switch (reason) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    case "refusal":
      return "content_filter";
    default:
      fail(ANT_TO_OAI, path, `Unsupported Anthropic stop_reason \"${reason}\"`);
  }
}

function mapOpenAIFinishReason(
  value: unknown,
  path: string,
  allowNull = false
): string | null {
  if (value === null && allowNull) return null;
  const reason = stringAt(value, OAI_TO_ANT, path, false);
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      fail(OAI_TO_ANT, path, `Unsupported OpenAI finish_reason \"${reason}\"`);
  }
}

interface AnthropicUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  thinkingTokens?: number;
}

function readAnthropicUsage(value: unknown, path: string): AnthropicUsage {
  const usage = objectAt(value, ANT_TO_OAI, path);
  assertAllowedKeys(
    usage,
    [
      "input_tokens",
      "output_tokens",
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
      "cache_creation",
      "output_tokens_details",
      "server_tool_use",
      "service_tier",
      "inference_geo",
    ],
    ANT_TO_OAI,
    path
  );
  const result: AnthropicUsage = {
    inputTokens:
      usage.input_tokens === undefined || usage.input_tokens === null
        ? 0
        : numberAt(usage.input_tokens, ANT_TO_OAI, `${path}.input_tokens`, {
            integer: true,
            nonNegative: true,
          }),
    outputTokens:
      usage.output_tokens === undefined || usage.output_tokens === null
        ? 0
        : numberAt(usage.output_tokens, ANT_TO_OAI, `${path}.output_tokens`, {
            integer: true,
            nonNegative: true,
          }),
  };
  if (
    usage.cache_creation_input_tokens !== undefined &&
    usage.cache_creation_input_tokens !== null
  ) {
    result.cacheCreationInputTokens = numberAt(
      usage.cache_creation_input_tokens,
      ANT_TO_OAI,
      `${path}.cache_creation_input_tokens`,
      { integer: true, nonNegative: true }
    );
  }
  if (
    usage.cache_read_input_tokens !== undefined &&
    usage.cache_read_input_tokens !== null
  ) {
    result.cacheReadInputTokens = numberAt(
      usage.cache_read_input_tokens,
      ANT_TO_OAI,
      `${path}.cache_read_input_tokens`,
      { integer: true, nonNegative: true }
    );
  }
  if (usage.cache_creation !== undefined && usage.cache_creation !== null) {
    const cacheCreation = objectAt(
      usage.cache_creation,
      ANT_TO_OAI,
      `${path}.cache_creation`
    );
    assertAllowedKeys(
      cacheCreation,
      ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"],
      ANT_TO_OAI,
      `${path}.cache_creation`
    );
    let cacheCreationBreakdown = 0;
    for (const key of [
      "ephemeral_1h_input_tokens",
      "ephemeral_5m_input_tokens",
    ]) {
      if (cacheCreation[key] !== undefined) {
        cacheCreationBreakdown += numberAt(cacheCreation[key], ANT_TO_OAI, `${path}.cache_creation.${key}`, {
          integer: true,
          nonNegative: true,
        });
      }
    }
    if (
      result.cacheCreationInputTokens !== undefined &&
      cacheCreationBreakdown !== result.cacheCreationInputTokens
    ) {
      fail(
        ANT_TO_OAI,
        `${path}.cache_creation`,
        "cache_creation breakdown does not match cache_creation_input_tokens"
      );
    }
  }
  if (
    usage.output_tokens_details !== undefined &&
    usage.output_tokens_details !== null
  ) {
    const details = objectAt(
      usage.output_tokens_details,
      ANT_TO_OAI,
      `${path}.output_tokens_details`
    );
    assertAllowedKeys(
      details,
      ["thinking_tokens"],
      ANT_TO_OAI,
      `${path}.output_tokens_details`
    );
    if (details.thinking_tokens !== undefined) {
      result.thinkingTokens = numberAt(
        details.thinking_tokens,
        ANT_TO_OAI,
        `${path}.output_tokens_details.thinking_tokens`,
        { integer: true, nonNegative: true }
      );
      if (result.thinkingTokens > result.outputTokens) {
        fail(
          ANT_TO_OAI,
          `${path}.output_tokens_details.thinking_tokens`,
          "thinking_tokens exceeds output_tokens"
        );
      }
    }
  }
  return result;
}

function anthropicUsageToOpenAI(usage: AnthropicUsage): JsonObject {
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const promptTokens = usage.inputTokens + cacheCreation + cacheRead;
  const converted: JsonObject = {
    prompt_tokens: promptTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: promptTokens + usage.outputTokens,
  };
  if (
    usage.cacheReadInputTokens !== undefined ||
    usage.cacheCreationInputTokens !== undefined
  ) {
    const details: JsonObject = { cached_tokens: cacheRead };
    if (usage.cacheCreationInputTokens !== undefined) {
      details.cache_write_tokens = cacheCreation;
    }
    converted.prompt_tokens_details = details;
  }
  if (usage.thinkingTokens !== undefined) {
    converted.completion_tokens_details = {
      reasoning_tokens: usage.thinkingTokens,
    };
  }
  return converted;
}

interface OpenAIUsage {
  promptTokens: number;
  completionTokens: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  thinkingTokens?: number;
}

function readOpenAIUsage(value: unknown, path: string): OpenAIUsage {
  const usage = objectAt(value, OAI_TO_ANT, path);
  assertAllowedKeys(
    usage,
    [
      "prompt_tokens",
      "completion_tokens",
      "total_tokens",
      "prompt_tokens_details",
      "completion_tokens_details",
      // Accepted extensions let a previous Anthropic -> OpenAI conversion make
      // a lossless round trip without changing standard OpenAI token totals.
      "cache_creation_input_tokens",
      "cache_read_input_tokens",
    ],
    OAI_TO_ANT,
    path
  );
  const promptTokens = numberAt(
    usage.prompt_tokens,
    OAI_TO_ANT,
    `${path}.prompt_tokens`,
    { integer: true, nonNegative: true }
  );
  const completionTokens = numberAt(
    usage.completion_tokens,
    OAI_TO_ANT,
    `${path}.completion_tokens`,
    { integer: true, nonNegative: true }
  );
  if (usage.total_tokens !== undefined) {
    const total = numberAt(usage.total_tokens, OAI_TO_ANT, `${path}.total_tokens`, {
      integer: true,
      nonNegative: true,
    });
    if (total !== promptTokens + completionTokens) {
      fail(OAI_TO_ANT, `${path}.total_tokens`, "total_tokens does not match prompt + completion");
    }
  }

  let cacheRead: number | undefined;
  let cacheCreation: number | undefined;
  if (usage.prompt_tokens_details !== undefined && usage.prompt_tokens_details !== null) {
    const details = objectAt(
      usage.prompt_tokens_details,
      OAI_TO_ANT,
      `${path}.prompt_tokens_details`
    );
    // Other detail counters do not alter the cache mapping.
    assertAllowedKeys(
      details,
      ["cached_tokens", "cache_write_tokens", "audio_tokens"],
      OAI_TO_ANT,
      `${path}.prompt_tokens_details`
    );
    if (details.cached_tokens !== undefined) {
      cacheRead = numberAt(
        details.cached_tokens,
        OAI_TO_ANT,
        `${path}.prompt_tokens_details.cached_tokens`,
        { integer: true, nonNegative: true }
      );
    }
    if (details.cache_write_tokens !== undefined) {
      cacheCreation = numberAt(
        details.cache_write_tokens,
        OAI_TO_ANT,
        `${path}.prompt_tokens_details.cache_write_tokens`,
        { integer: true, nonNegative: true }
      );
    }
    if (details.audio_tokens !== undefined && details.audio_tokens !== 0) {
      fail(
        OAI_TO_ANT,
        `${path}.prompt_tokens_details.audio_tokens`,
        "Audio token usage has no Anthropic Messages equivalent"
      );
    }
  }
  if (usage.cache_read_input_tokens !== undefined) {
    const direct = numberAt(
      usage.cache_read_input_tokens,
      OAI_TO_ANT,
      `${path}.cache_read_input_tokens`,
      { integer: true, nonNegative: true }
    );
    if (cacheRead !== undefined && direct !== cacheRead) {
      fail(OAI_TO_ANT, `${path}.cache_read_input_tokens`, "Cache token counters disagree");
    }
    cacheRead = direct;
  }
  if (usage.cache_creation_input_tokens !== undefined) {
    const direct = numberAt(
      usage.cache_creation_input_tokens,
      OAI_TO_ANT,
      `${path}.cache_creation_input_tokens`,
      { integer: true, nonNegative: true }
    );
    if (cacheCreation !== undefined && direct !== cacheCreation) {
      fail(OAI_TO_ANT, `${path}.cache_creation_input_tokens`, "Cache token counters disagree");
    }
    cacheCreation = direct;
  }
  let thinkingTokens: number | undefined;
  if (
    usage.completion_tokens_details !== undefined &&
    usage.completion_tokens_details !== null
  ) {
    const details = objectAt(
      usage.completion_tokens_details,
      OAI_TO_ANT,
      `${path}.completion_tokens_details`
    );
    assertAllowedKeys(
      details,
      [
        "reasoning_tokens",
        "audio_tokens",
        "accepted_prediction_tokens",
        "rejected_prediction_tokens",
      ],
      OAI_TO_ANT,
      `${path}.completion_tokens_details`
    );
    if (details.reasoning_tokens !== undefined) {
      thinkingTokens = numberAt(
        details.reasoning_tokens,
        OAI_TO_ANT,
        `${path}.completion_tokens_details.reasoning_tokens`,
        { integer: true, nonNegative: true }
      );
      if (thinkingTokens > completionTokens) {
        fail(
          OAI_TO_ANT,
          `${path}.completion_tokens_details.reasoning_tokens`,
          "reasoning_tokens exceeds completion_tokens"
        );
      }
    }
    for (const unsupported of [
      "audio_tokens",
      "accepted_prediction_tokens",
      "rejected_prediction_tokens",
    ] as const) {
      if (details[unsupported] !== undefined && details[unsupported] !== 0) {
        fail(
          OAI_TO_ANT,
          `${path}.completion_tokens_details.${unsupported}`,
          `${unsupported} has no Anthropic Messages equivalent`
        );
      }
    }
  }
  if ((cacheRead ?? 0) + (cacheCreation ?? 0) > promptTokens) {
    fail(OAI_TO_ANT, path, "Cached input tokens exceed prompt_tokens");
  }
  return {
    promptTokens,
    completionTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheCreation,
    thinkingTokens,
  };
}

function openAIUsageToAnthropic(usage: OpenAIUsage): JsonObject {
  const cacheRead = usage.cacheReadInputTokens ?? 0;
  const cacheCreation = usage.cacheCreationInputTokens ?? 0;
  const converted: JsonObject = {
    input_tokens: usage.promptTokens - cacheRead - cacheCreation,
    output_tokens: usage.completionTokens,
  };
  if (usage.cacheCreationInputTokens !== undefined) {
    converted.cache_creation_input_tokens = cacheCreation;
  }
  if (usage.cacheReadInputTokens !== undefined) {
    converted.cache_read_input_tokens = cacheRead;
  }
  if (usage.thinkingTokens !== undefined) {
    converted.output_tokens_details = { thinking_tokens: usage.thinkingTokens };
  }
  return converted;
}

/** Convert a non-streaming Anthropic Messages response to OpenAI Chat. */
export function convertAnthropicResponseToOpenAIChat(
  value: unknown,
  fallbackModel = ""
): JsonObject {
  const response = objectAt(value, ANT_TO_OAI, "$response");
  assertAllowedKeys(
    response,
    [
      "id",
      "type",
      "role",
      "model",
      "content",
      "stop_reason",
      "stop_sequence",
      "usage",
      "container",
    ],
    ANT_TO_OAI,
    "$response"
  );
  if (response.type !== "message") {
    fail(ANT_TO_OAI, "$response.type", "Expected an Anthropic message response");
  }
  if (response.role !== "assistant") {
    fail(ANT_TO_OAI, "$response.role", "Expected assistant response role");
  }
  const textParts: string[] = [];
  const toolCalls: JsonObject[] = [];
  arrayAt(response.content, ANT_TO_OAI, "$response.content").forEach(
    (rawBlock, index) => {
      const path = `$response.content[${index}]`;
      const block = objectAt(rawBlock, ANT_TO_OAI, path);
      if (block.type === "text") {
        assertAllowedKeys(block, ["type", "text"], ANT_TO_OAI, path);
        textParts.push(stringAt(block.text, ANT_TO_OAI, `${path}.text`));
      } else if (block.type === "tool_use") {
        assertAllowedKeys(block, ["type", "id", "name", "input"], ANT_TO_OAI, path);
        toolCalls.push({
          id: stringAt(block.id, ANT_TO_OAI, `${path}.id`, false),
          type: "function",
          function: {
            name: stringAt(block.name, ANT_TO_OAI, `${path}.name`, false),
            arguments: stringifyToolInput(block.input, ANT_TO_OAI, `${path}.input`),
          },
        });
      } else {
        fail(
          ANT_TO_OAI,
          `${path}.type`,
          `Unsupported Anthropic response block type \"${String(block.type)}\"`
        );
      }
    }
  );
  const message: JsonObject = {
    role: "assistant",
    content: textParts.length > 0 ? textParts.join("") : null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const rawUsage = objectAt(response.usage, ANT_TO_OAI, "$response.usage");
  if (rawUsage.input_tokens === undefined || rawUsage.input_tokens === null) {
    fail(ANT_TO_OAI, "$response.usage.input_tokens", "Missing input_tokens");
  }
  if (rawUsage.output_tokens === undefined || rawUsage.output_tokens === null) {
    fail(ANT_TO_OAI, "$response.usage.output_tokens", "Missing output_tokens");
  }
  const usage = readAnthropicUsage(rawUsage, "$response.usage");
  return {
    id: stringAt(response.id, ANT_TO_OAI, "$response.id", false),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model:
      response.model === undefined
        ? fallbackModel
        : stringAt(response.model, ANT_TO_OAI, "$response.model"),
    choices: [
      {
        index: 0,
        message,
        finish_reason: mapAnthropicStopReason(
          response.stop_reason,
          "$response.stop_reason",
          true
        ),
        logprobs: null,
      },
    ],
    usage: anthropicUsageToOpenAI(usage),
  };
}

/** Convert a non-streaming OpenAI Chat response to Anthropic Messages. */
export function convertOpenAIChatResponseToAnthropic(
  value: unknown,
  fallbackModel = ""
): JsonObject {
  const response = objectAt(value, OAI_TO_ANT, "$response");
  assertAllowedKeys(
    response,
    [
      "id",
      "object",
      "created",
      "model",
      "choices",
      "usage",
      "system_fingerprint",
      "service_tier",
      // CodeAgent 的非标准追踪元数据；不影响 Anthropic 响应语义。
      "request_timestamp",
      "created_timestamp",
    ],
    OAI_TO_ANT,
    "$response"
  );
  if (response.object !== undefined && response.object !== "chat.completion") {
    fail(OAI_TO_ANT, "$response.object", "Expected an OpenAI chat.completion response");
  }
  const choices = arrayAt(response.choices, OAI_TO_ANT, "$response.choices");
  if (choices.length !== 1) {
    fail(OAI_TO_ANT, "$response.choices", "Anthropic Messages can represent exactly one choice");
  }
  const choice = objectAt(choices[0], OAI_TO_ANT, "$response.choices[0]");
  assertAllowedKeys(
    choice,
    ["index", "message", "finish_reason", "logprobs"],
    OAI_TO_ANT,
    "$response.choices[0]"
  );
  if (choice.logprobs !== undefined && choice.logprobs !== null) {
    fail(OAI_TO_ANT, "$response.choices[0].logprobs", "Log probabilities are not representable");
  }
  const message = objectAt(choice.message, OAI_TO_ANT, "$response.choices[0].message");
  assertAllowedKeys(
    message,
    [
      "role",
      "content",
      "tool_calls",
      "reasoning_content",
      "thinking",
      "refusal",
      "annotations",
      "audio",
      "function_call",
    ],
    OAI_TO_ANT,
    "$response.choices[0].message"
  );
  if (message.role !== "assistant") {
    fail(OAI_TO_ANT, "$response.choices[0].message.role", "Expected assistant response role");
  }
  for (const unsupported of ["refusal", "annotations", "audio", "function_call"] as const) {
    const field = message[unsupported];
    if (
      field !== undefined &&
      field !== null &&
      field !== "" &&
      (!Array.isArray(field) || field.length > 0)
    ) {
      fail(
        OAI_TO_ANT,
        `$response.choices[0].message.${unsupported}`,
        `OpenAI ${unsupported} content is not representable`
      );
    }
  }
  const content: JsonObject[] = [];
  const text = textFromOpenAIContent(
    message.content,
    OAI_TO_ANT,
    "$response.choices[0].message.content",
    true
  );
  if (text !== "") content.push({ type: "text", text });
  if (message.tool_calls !== undefined && message.tool_calls !== null) {
    arrayAt(
      message.tool_calls,
      OAI_TO_ANT,
      "$response.choices[0].message.tool_calls"
    ).forEach((rawCall, index) => {
      const path = `$response.choices[0].message.tool_calls[${index}]`;
      const call = objectAt(rawCall, OAI_TO_ANT, path);
      assertAllowedKeys(call, ["id", "type", "function"], OAI_TO_ANT, path);
      if (call.type !== "function") {
        fail(OAI_TO_ANT, `${path}.type`, "Only function tool calls are supported");
      }
      const fn = objectAt(call.function, OAI_TO_ANT, `${path}.function`);
      assertAllowedKeys(fn, ["name", "arguments"], OAI_TO_ANT, `${path}.function`);
      content.push({
        type: "tool_use",
        id: stringAt(call.id, OAI_TO_ANT, `${path}.id`, false),
        name: stringAt(fn.name, OAI_TO_ANT, `${path}.function.name`, false),
        input: parseToolArguments(
          fn.arguments,
          OAI_TO_ANT,
          `${path}.function.arguments`
        ),
      });
    });
  }
  if (content.length === 0) content.push({ type: "text", text: "" });
  return {
    id: stringAt(response.id, OAI_TO_ANT, "$response.id", false),
    type: "message",
    role: "assistant",
    model:
      response.model === undefined
        ? fallbackModel
        : stringAt(response.model, OAI_TO_ANT, "$response.model"),
    content,
    stop_reason: mapOpenAIFinishReason(
      choice.finish_reason,
      "$response.choices[0].finish_reason",
      true
    ),
    stop_sequence: null,
    usage: openAIUsageToAnthropic(readOpenAIUsage(response.usage, "$response.usage")),
  };
}

interface SseEvent {
  event: string;
  data: string;
}

/** Incremental SSE parser. It buffers partial lines, events, CRLFs and UTF-8. */
class SseParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private buffer = "";

  constructor(private readonly direction: ConversionDirection) {}

  feed(input: string | Uint8Array): SseEvent[] {
    try {
      this.buffer +=
        typeof input === "string" ? input : this.decoder.decode(input, { stream: true });
    } catch (error) {
      fail(
        this.direction,
        "$stream",
        `Invalid UTF-8 in SSE stream: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return this.takeCompleteEvents(false);
  }

  finish(): SseEvent[] {
    try {
      this.buffer += this.decoder.decode();
    } catch (error) {
      fail(
        this.direction,
        "$stream",
        `Invalid UTF-8 in SSE stream: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    return this.takeCompleteEvents(true);
  }

  private takeCompleteEvents(flush: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    const separator = /\r?\n\r?\n/g;
    let consumed = 0;
    let match: RegExpExecArray | null;
    while ((match = separator.exec(this.buffer)) !== null) {
      const eventLength = match.index - consumed;
      if (eventLength > MAX_SSE_BUFFER) {
        fail(this.direction, "$stream", "SSE 事件超过 1 MiB 限制");
      }
      const event = this.parseBlock(this.buffer.slice(consumed, match.index));
      if (event) events.push(event);
      consumed = match.index + match[0].length;
      separator.lastIndex = consumed;
    }
    if (consumed > 0) this.buffer = this.buffer.slice(consumed);
    if (flush && this.buffer.trim() !== "") {
      if (this.buffer.length > MAX_SSE_BUFFER) {
        fail(this.direction, "$stream", "SSE 事件超过 1 MiB 限制");
      }
      const event = this.parseBlock(this.buffer);
      if (event) events.push(event);
      this.buffer = "";
    }
    if (this.buffer.length > MAX_SSE_BUFFER) {
      fail(this.direction, "$stream", "SSE 事件超过 1 MiB 限制");
    }
    return events;
  }

  private parseBlock(block: string): SseEvent | null {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line === "" || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
      // id and retry have no bearing on protocol conversion.
    }
    return data.length > 0 ? { event, data: data.join("\n") } : null;
  }
}

function oaiSse(data: JsonObject): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function anthropicSse(event: string, data: JsonObject): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

interface AnthropicStreamBlock {
  kind: "text" | "tool";
  toolIndex?: number;
  arguments: string;
  stopped: boolean;
}

/** Incrementally convert Anthropic Messages SSE to OpenAI Chat SSE. */
export class AnthropicToOpenAIStreamConverter {
  private readonly parser = new SseParser(ANT_TO_OAI);
  private pendingFrames = "";
  private terminalDelivered = false;
  private started = false;
  private ended = false;
  private finishSent = false;
  private id = "chatcmpl-relay";
  private model = "";
  private created = Math.floor(Date.now() / 1000);
  private nextToolIndex = 0;
  private readonly blocks = new Map<number, AnthropicStreamBlock>();
  private totalToolArguments = 0;
  private usage: AnthropicUsage = { inputTokens: 0, outputTokens: 0 };
  private sawUsage = false;
  private stopReason: string | null = null;

  feed(input: string | Uint8Array): string {
    const output = this.convertEvents(this.parser.feed(input));
    if (this.ended) this.terminalDelivered = true;
    return output;
  }

  finish(): string {
    const converted = this.convertEvents(this.parser.finish());
    if (!this.started) {
      this.pendingFrames += converted;
      fail(ANT_TO_OAI, "$stream", "Anthropic stream ended before message_start");
    }
    if (this.started && !this.ended) {
      this.pendingFrames += converted;
      fail(ANT_TO_OAI, "$stream", "Anthropic stream ended before message_stop");
    }
    if (this.ended) this.terminalDelivered = true;
    return converted;
  }

  failureFrame(message: string): string {
    const pending = this.pendingFrames;
    this.pendingFrames = "";
    if (this.terminalDelivered) return pending;
    this.ended = true;
    this.terminalDelivered = true;
    return pending + oaiSse({
      error: {
        message,
        type: "route_conversion_error",
        param: null,
        code: null,
      },
    }) + "data: [DONE]\n\n";
  }

  private convertEvents(events: SseEvent[]): string {
    let output = "";
    try {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (this.isTerminalEvent(event) && index !== events.length - 1) {
          fail(ANT_TO_OAI, "$stream", "Received data after message_stop");
        }
        output += this.convertEvent(event);
      }
      return output;
    } catch (error) {
      this.pendingFrames += output;
      throw error;
    }
  }

  private isTerminalEvent(event: SseEvent): boolean {
    if (event.event === "message_stop") return true;
    try {
      const parsed = JSON.parse(event.data) as unknown;
      return isObject(parsed) && parsed.type === "message_stop";
    } catch {
      return false;
    }
  }

  private convertEvent(event: SseEvent): string {
    if (this.ended) {
      fail(ANT_TO_OAI, "$stream", "Received data after message_stop");
    }
    const data = parseJsonObject(event.data, ANT_TO_OAI, "$stream.data");
    const type = data.type ?? event.event;
    if (typeof type !== "string") fail(ANT_TO_OAI, "$stream.type", "Missing event type");
    if (event.event !== "message" && data.type !== undefined && event.event !== type) {
      fail(ANT_TO_OAI, "$stream.type", "SSE event name and payload type disagree");
    }

    switch (type) {
      case "ping":
        return "";
      case "error":
        fail(ANT_TO_OAI, "$stream.error", `Anthropic stream error: ${event.data}`);
      case "message_start":
        return this.messageStart(data);
      case "content_block_start":
        return this.contentBlockStart(data);
      case "content_block_delta":
        return this.contentBlockDelta(data);
      case "content_block_stop":
        return this.contentBlockStop(data);
      case "message_delta":
        return this.messageDelta(data);
      case "message_stop":
        return this.messageStop();
      default:
        fail(ANT_TO_OAI, "$stream.type", `Unsupported Anthropic SSE event \"${type}\"`);
    }
  }

  private messageStart(data: JsonObject): string {
    if (this.started) fail(ANT_TO_OAI, "$stream", "Duplicate message_start");
    const message = objectAt(data.message, ANT_TO_OAI, "$stream.message_start.message");
    if (message.type !== undefined && message.type !== "message") {
      fail(ANT_TO_OAI, "$stream.message_start.message.type", "Expected message type");
    }
    if (message.role !== undefined && message.role !== "assistant") {
      fail(ANT_TO_OAI, "$stream.message_start.message.role", "Expected assistant role");
    }
    if (message.content !== undefined) {
      const initialContent = arrayAt(
        message.content,
        ANT_TO_OAI,
        "$stream.message_start.message.content"
      );
      if (initialContent.length > 0) {
        fail(
          ANT_TO_OAI,
          "$stream.message_start.message.content",
          "Non-empty message_start content cannot be converted incrementally"
        );
      }
    }
    this.id = stringAt(message.id, ANT_TO_OAI, "$stream.message_start.message.id", false);
    this.model = stringAt(
      message.model ?? "",
      ANT_TO_OAI,
      "$stream.message_start.message.model"
    );
    if (message.usage !== undefined) {
      this.mergeUsage(readAnthropicUsage(message.usage, "$stream.message_start.message.usage"));
    }
    this.started = true;
    return this.chunk({ role: "assistant", content: "" }, null);
  }

  private contentBlockStart(data: JsonObject): string {
    this.requireStarted("content_block_start");
    const index = numberAt(data.index, ANT_TO_OAI, "$stream.content_block_start.index", {
      integer: true,
      nonNegative: true,
    });
    if (this.blocks.has(index)) {
      fail(ANT_TO_OAI, "$stream.content_block_start.index", `Duplicate content block ${index}`);
    }
    if (this.blocks.size >= MAX_STREAM_BLOCKS) {
      fail(ANT_TO_OAI, "$stream.content_block_start", "流式 content block 超过 256 个");
    }
    const content = objectAt(
      data.content_block,
      ANT_TO_OAI,
      "$stream.content_block_start.content_block"
    );
    if (content.type === "text") {
      assertAllowedKeys(
        content,
        ["type", "text"],
        ANT_TO_OAI,
        "$stream.content_block_start.content_block"
      );
      const text = stringAt(
        content.text,
        ANT_TO_OAI,
        "$stream.content_block_start.content_block.text"
      );
      this.blocks.set(index, { kind: "text", arguments: "", stopped: false });
      return text === "" ? "" : this.chunk({ content: text }, null);
    }
    if (content.type === "tool_use") {
      assertAllowedKeys(
        content,
        ["type", "id", "name", "input"],
        ANT_TO_OAI,
        "$stream.content_block_start.content_block"
      );
      const toolIndex = this.nextToolIndex++;
      const initialArguments = stringifyToolInput(
        content.input,
        ANT_TO_OAI,
        "$stream.content_block_start.content_block.input"
      );
      const argumentsText = initialArguments === "{}" ? "" : initialArguments;
      if (argumentsText.length > MAX_TOOL_ARGUMENTS) {
        fail(ANT_TO_OAI, "$stream.content_block_start", "工具参数超过 1 MiB 限制");
      }
      if (this.totalToolArguments + argumentsText.length > MAX_TOTAL_TOOL_ARGUMENTS) {
        fail(ANT_TO_OAI, "$stream.content_block_start", "流式工具参数累计超过 16 MiB 限制");
      }
      this.totalToolArguments += argumentsText.length;
      this.blocks.set(index, {
        kind: "tool",
        toolIndex,
        arguments: argumentsText,
        stopped: false,
      });
      return this.chunk(
        {
          tool_calls: [
            {
              index: toolIndex,
              id: stringAt(
                content.id,
                ANT_TO_OAI,
                "$stream.content_block_start.content_block.id",
                false
              ),
              type: "function",
              function: {
                name: stringAt(
                  content.name,
                  ANT_TO_OAI,
                  "$stream.content_block_start.content_block.name",
                  false
                ),
                arguments: argumentsText,
              },
            },
          ],
        },
        null
      );
    }
    fail(
      ANT_TO_OAI,
      "$stream.content_block_start.content_block.type",
      `Unsupported Anthropic stream block \"${String(content.type)}\"`
    );
  }

  private contentBlockDelta(data: JsonObject): string {
    this.requireStarted("content_block_delta");
    const index = numberAt(data.index, ANT_TO_OAI, "$stream.content_block_delta.index", {
      integer: true,
      nonNegative: true,
    });
    const block = this.blocks.get(index);
    if (!block || block.stopped) {
      fail(ANT_TO_OAI, "$stream.content_block_delta.index", `Unknown or stopped content block ${index}`);
    }
    const delta = objectAt(data.delta, ANT_TO_OAI, "$stream.content_block_delta.delta");
    if (delta.type === "text_delta" && block.kind === "text") {
      assertAllowedKeys(delta, ["type", "text"], ANT_TO_OAI, "$stream.content_block_delta.delta");
      return this.chunk(
        {
          content: stringAt(
            delta.text,
            ANT_TO_OAI,
            "$stream.content_block_delta.delta.text"
          ),
        },
        null
      );
    }
    if (delta.type === "input_json_delta" && block.kind === "tool") {
      assertAllowedKeys(
        delta,
        ["type", "partial_json"],
        ANT_TO_OAI,
        "$stream.content_block_delta.delta"
      );
      const partial = stringAt(
        delta.partial_json,
        ANT_TO_OAI,
        "$stream.content_block_delta.delta.partial_json"
      );
      if (block.arguments.length + partial.length > MAX_TOOL_ARGUMENTS) {
        fail(ANT_TO_OAI, "$stream.content_block_delta", "工具参数超过 1 MiB 限制");
      }
      if (this.totalToolArguments + partial.length > MAX_TOTAL_TOOL_ARGUMENTS) {
        fail(ANT_TO_OAI, "$stream.content_block_delta", "流式工具参数累计超过 16 MiB 限制");
      }
      this.totalToolArguments += partial.length;
      block.arguments += partial;
      return this.chunk(
        {
          tool_calls: [
            {
              index: block.toolIndex,
              function: { arguments: partial },
            },
          ],
        },
        null
      );
    }
    fail(
      ANT_TO_OAI,
      "$stream.content_block_delta.delta.type",
      `Delta type \"${String(delta.type)}\" does not match its content block`
    );
  }

  private contentBlockStop(data: JsonObject): string {
    const index = numberAt(data.index, ANT_TO_OAI, "$stream.content_block_stop.index", {
      integer: true,
      nonNegative: true,
    });
    const block = this.blocks.get(index);
    if (!block || block.stopped) {
      fail(ANT_TO_OAI, "$stream.content_block_stop.index", `Unknown or stopped content block ${index}`);
    }
    if (block.kind === "tool") {
      parseToolArguments(
        block.arguments === "" ? "{}" : block.arguments,
        ANT_TO_OAI,
        `$stream.content_blocks[${index}].arguments`
      );
    }
    block.stopped = true;
    return "";
  }

  private messageDelta(data: JsonObject): string {
    this.requireStarted("message_delta");
    const delta = objectAt(data.delta, ANT_TO_OAI, "$stream.message_delta.delta");
    assertAllowedKeys(
      delta,
      ["stop_reason", "stop_sequence"],
      ANT_TO_OAI,
      "$stream.message_delta.delta"
    );
    if (data.usage !== undefined) {
      this.mergeUsage(readAnthropicUsage(data.usage, "$stream.message_delta.usage"));
    }
    if (delta.stop_reason !== undefined && delta.stop_reason !== null) {
      this.stopReason = mapAnthropicStopReason(
        delta.stop_reason,
        "$stream.message_delta.delta.stop_reason"
      );
      if (!this.finishSent) {
        this.finishSent = true;
        return this.chunk({}, this.stopReason);
      }
    }
    return "";
  }

  private messageStop(): string {
    this.requireStarted("message_stop");
    if (this.stopReason === null) {
      fail(ANT_TO_OAI, "$stream", "message_stop arrived before a non-null stop_reason");
    }
    for (const [index, block] of this.blocks) {
      if (!block.stopped) {
        fail(ANT_TO_OAI, "$stream", `Content block ${index} was not stopped`);
      }
    }
    let output = "";
    if (!this.finishSent) output += this.chunk({}, this.stopReason);
    if (this.sawUsage) {
      output += oaiSse({
        id: this.id,
        object: "chat.completion.chunk",
        created: this.created,
        model: this.model,
        choices: [],
        usage: anthropicUsageToOpenAI(this.usage),
      });
    }
    this.ended = true;
    return `${output}data: [DONE]\n\n`;
  }

  private mergeUsage(next: AnthropicUsage): void {
    this.sawUsage = true;
    this.usage.inputTokens = Math.max(this.usage.inputTokens, next.inputTokens);
    this.usage.outputTokens = Math.max(this.usage.outputTokens, next.outputTokens);
    if (next.cacheCreationInputTokens !== undefined) {
      this.usage.cacheCreationInputTokens = Math.max(
        this.usage.cacheCreationInputTokens ?? 0,
        next.cacheCreationInputTokens
      );
    }
    if (next.cacheReadInputTokens !== undefined) {
      this.usage.cacheReadInputTokens = Math.max(
        this.usage.cacheReadInputTokens ?? 0,
        next.cacheReadInputTokens
      );
    }
    if (next.thinkingTokens !== undefined) {
      this.usage.thinkingTokens = Math.max(
        this.usage.thinkingTokens ?? 0,
        next.thinkingTokens
      );
    }
  }

  private requireStarted(event: string): void {
    if (!this.started) fail(ANT_TO_OAI, "$stream", `${event} arrived before message_start`);
  }

  private chunk(delta: JsonObject, finishReason: string | null): string {
    return oaiSse({
      id: this.id,
      object: "chat.completion.chunk",
      created: this.created,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    });
  }
}

interface OpenAIStreamTool {
  anthropicIndex: number;
  id?: string;
  name?: string;
  started: boolean;
  stopped: boolean;
  pendingArguments: string;
  allArguments: string;
}

/** Incrementally convert OpenAI Chat SSE to Anthropic Messages SSE. */
export class OpenAIToAnthropicStreamConverter {
  private readonly parser = new SseParser(OAI_TO_ANT);
  private pendingFrames = "";
  private terminalDelivered = false;
  private started = false;
  private ended = false;
  private id = "msg_relay";
  private model = "";
  private nextBlockIndex = 0;
  private textBlockIndex: number | null = null;
  private textBlockStopped = false;
  private readonly tools = new Map<number, OpenAIStreamTool>();
  private totalToolArguments = 0;
  private finishReason: string | null = null;
  private usage: OpenAIUsage | null = null;

  feed(input: string | Uint8Array): string {
    const output = this.convertEvents(this.parser.feed(input));
    if (this.ended) this.terminalDelivered = true;
    return output;
  }

  finish(): string {
    let output = this.convertEvents(this.parser.finish());
    if (!this.started) {
      this.pendingFrames += output;
      fail(OAI_TO_ANT, "$stream", "OpenAI stream ended before any chat chunk");
    }
    if (this.started && !this.ended) {
      if (this.finishReason === null) {
        this.pendingFrames += output;
        fail(OAI_TO_ANT, "$stream", "OpenAI stream ended without finish_reason or [DONE]");
      }
      output += this.endMessage();
    }
    if (this.ended) this.terminalDelivered = true;
    return output;
  }

  failureFrame(message: string): string {
    const pending = this.pendingFrames;
    this.pendingFrames = "";
    if (this.terminalDelivered) return pending;
    this.ended = true;
    this.terminalDelivered = true;
    return pending + anthropicSse("error", {
      type: "error",
      error: { type: "api_error", message },
    });
  }

  private convertEvents(events: SseEvent[]): string {
    let output = "";
    try {
      for (let index = 0; index < events.length; index += 1) {
        const event = events[index];
        if (event.data.trim() === "[DONE]" && index !== events.length - 1) {
          fail(OAI_TO_ANT, "$stream", "Received data after [DONE]");
        }
        output += this.convertEvent(event);
      }
      return output;
    } catch (error) {
      this.pendingFrames += output;
      throw error;
    }
  }

  private convertEvent(event: SseEvent): string {
    if (this.ended) fail(OAI_TO_ANT, "$stream", "Received data after [DONE]");
    if (event.data.trim() === "[DONE]") return this.endMessage();
    const data = parseJsonObject(event.data, OAI_TO_ANT, "$stream.data");
    if (data.error !== undefined) {
      fail(OAI_TO_ANT, "$stream.error", `OpenAI stream error: ${JSON.stringify(data.error)}`);
    }
    if (data.usage !== undefined && data.usage !== null) {
      this.usage = readOpenAIUsage(data.usage, "$stream.usage");
    }
    const choices = arrayAt(data.choices, OAI_TO_ANT, "$stream.choices");
    if (choices.length === 0) return "";
    if (choices.length !== 1) {
      fail(OAI_TO_ANT, "$stream.choices", "Anthropic Messages can represent exactly one choice");
    }
    const choice = objectAt(choices[0], OAI_TO_ANT, "$stream.choices[0]");
    if (choice.index !== undefined && choice.index !== 0) {
      fail(OAI_TO_ANT, "$stream.choices[0].index", "Only choice index 0 is supported");
    }
    let output = this.ensureMessageStart(data);
    const delta = objectAt(choice.delta ?? {}, OAI_TO_ANT, "$stream.choices[0].delta");
    assertAllowedKeys(
      delta,
      [
        "role",
        "content",
        "tool_calls",
        "reasoning_content",
        "thinking",
        "refusal",
        "function_call",
        "audio",
      ],
      OAI_TO_ANT,
      "$stream.choices[0].delta"
    );
    if (delta.role !== undefined && delta.role !== "assistant") {
      fail(OAI_TO_ANT, "$stream.choices[0].delta.role", "Expected assistant delta role");
    }
    for (const unsupported of ["refusal", "function_call", "audio"] as const) {
      const field = delta[unsupported];
      if (field !== undefined && field !== null && field !== "") {
        fail(
          OAI_TO_ANT,
          `$stream.choices[0].delta.${unsupported}`,
          `OpenAI ${unsupported} delta is not representable`
        );
      }
    }
    if (delta.content !== undefined && delta.content !== null) {
      const text = stringAt(
        delta.content,
        OAI_TO_ANT,
        "$stream.choices[0].delta.content"
      );
      if (text !== "") output += this.textDelta(text);
    }
    if (delta.tool_calls !== undefined && delta.tool_calls !== null) {
      output += this.toolCallDeltas(delta.tool_calls);
    }
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      const mapped = mapOpenAIFinishReason(
        choice.finish_reason,
        "$stream.choices[0].finish_reason"
      );
      if (this.finishReason !== null && this.finishReason !== mapped) {
        fail(OAI_TO_ANT, "$stream.choices[0].finish_reason", "Conflicting finish reasons");
      }
      this.finishReason = mapped;
      output += this.stopContentBlocks();
    }
    return output;
  }

  private ensureMessageStart(data: JsonObject): string {
    if (this.started) {
      if (data.id !== undefined && data.id !== this.id) {
        fail(OAI_TO_ANT, "$stream.id", "Message id changed during stream");
      }
      if (data.model !== undefined && data.model !== this.model) {
        fail(OAI_TO_ANT, "$stream.model", "Model changed during stream");
      }
      return "";
    }
    this.id = stringAt(data.id ?? "msg_relay", OAI_TO_ANT, "$stream.id", false);
    this.model = stringAt(data.model ?? "", OAI_TO_ANT, "$stream.model");
    this.started = true;
    const initialUsage: JsonObject = { input_tokens: 0, output_tokens: 0 };
    if (this.usage) Object.assign(initialUsage, openAIUsageToAnthropic(this.usage));
    return anthropicSse("message_start", {
      type: "message_start",
      message: {
        id: this.id,
        type: "message",
        role: "assistant",
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: initialUsage,
      },
    });
  }

  private textDelta(text: string): string {
    let output = "";
    if (this.textBlockIndex === null) {
      this.textBlockIndex = this.nextBlockIndex++;
      output += anthropicSse("content_block_start", {
        type: "content_block_start",
        index: this.textBlockIndex,
        content_block: { type: "text", text: "" },
      });
    }
    if (this.textBlockStopped) {
      fail(OAI_TO_ANT, "$stream.choices[0].delta.content", "Text arrived after its block stopped");
    }
    return (
      output +
      anthropicSse("content_block_delta", {
        type: "content_block_delta",
        index: this.textBlockIndex,
        delta: { type: "text_delta", text },
      })
    );
  }

  private toolCallDeltas(value: unknown): string {
    let output = "";
    arrayAt(value, OAI_TO_ANT, "$stream.choices[0].delta.tool_calls").forEach(
      (rawCall, arrayIndex) => {
        const path = `$stream.choices[0].delta.tool_calls[${arrayIndex}]`;
        const call = objectAt(rawCall, OAI_TO_ANT, path);
        assertAllowedKeys(call, ["index", "id", "type", "function"], OAI_TO_ANT, path);
        const toolIndex = numberAt(call.index, OAI_TO_ANT, `${path}.index`, {
          integer: true,
          nonNegative: true,
        });
        let tool = this.tools.get(toolIndex);
        if (!tool) {
          if (this.tools.size >= MAX_STREAM_BLOCKS) {
            fail(OAI_TO_ANT, path, "流式工具调用超过 256 个");
          }
          tool = {
            anthropicIndex: this.nextBlockIndex++,
            started: false,
            stopped: false,
            pendingArguments: "",
            allArguments: "",
          };
          this.tools.set(toolIndex, tool);
        }
        if (tool.stopped) fail(OAI_TO_ANT, path, `Tool call ${toolIndex} already stopped`);
        if (call.type !== undefined && call.type !== "function") {
          fail(OAI_TO_ANT, `${path}.type`, "Only function tool calls are supported");
        }
        if (call.id !== undefined) {
          const id = stringAt(call.id, OAI_TO_ANT, `${path}.id`, false);
          if (tool.id !== undefined && tool.id !== id) {
            fail(OAI_TO_ANT, `${path}.id`, `Tool call ${toolIndex} id changed`);
          }
          tool.id = id;
        }
        if (call.function !== undefined) {
          const fn = objectAt(call.function, OAI_TO_ANT, `${path}.function`);
          assertAllowedKeys(fn, ["name", "arguments"], OAI_TO_ANT, `${path}.function`);
          if (fn.name !== undefined) {
            const name = stringAt(fn.name, OAI_TO_ANT, `${path}.function.name`, false);
            if (tool.name !== undefined && tool.name !== name) {
              fail(OAI_TO_ANT, `${path}.function.name`, `Tool call ${toolIndex} name changed`);
            }
            tool.name = name;
          }
          if (fn.arguments !== undefined) {
            const args = stringAt(fn.arguments, OAI_TO_ANT, `${path}.function.arguments`);
            if (tool.allArguments.length + args.length > MAX_TOOL_ARGUMENTS) {
              fail(OAI_TO_ANT, `${path}.function.arguments`, "工具参数超过 1 MiB 限制");
            }
            if (this.totalToolArguments + args.length > MAX_TOTAL_TOOL_ARGUMENTS) {
              fail(OAI_TO_ANT, `${path}.function.arguments`, "流式工具参数累计超过 16 MiB 限制");
            }
            this.totalToolArguments += args.length;
            tool.pendingArguments += args;
            tool.allArguments += args;
          }
        }
        if (!tool.started && tool.id !== undefined && tool.name !== undefined) {
          tool.started = true;
          output += anthropicSse("content_block_start", {
            type: "content_block_start",
            index: tool.anthropicIndex,
            content_block: {
              type: "tool_use",
              id: tool.id,
              name: tool.name,
              input: {},
            },
          });
        }
        if (tool.started && tool.pendingArguments !== "") {
          output += anthropicSse("content_block_delta", {
            type: "content_block_delta",
            index: tool.anthropicIndex,
            delta: {
              type: "input_json_delta",
              partial_json: tool.pendingArguments,
            },
          });
          tool.pendingArguments = "";
        }
      }
    );
    return output;
  }

  private stopContentBlocks(): string {
    let output = "";
    if (this.textBlockIndex !== null && !this.textBlockStopped) {
      this.textBlockStopped = true;
      output += anthropicSse("content_block_stop", {
        type: "content_block_stop",
        index: this.textBlockIndex,
      });
    }
    for (const [toolIndex, tool] of [...this.tools].sort((a, b) => a[0] - b[0])) {
      if (!tool.started) {
        fail(OAI_TO_ANT, "$stream", `Tool call ${toolIndex} never supplied both id and name`);
      }
      if (!tool.stopped) {
        parseToolArguments(
          tool.allArguments === "" ? "{}" : tool.allArguments,
          OAI_TO_ANT,
          `$stream.tool_calls[${toolIndex}].function.arguments`
        );
        tool.stopped = true;
        output += anthropicSse("content_block_stop", {
          type: "content_block_stop",
          index: tool.anthropicIndex,
        });
      }
    }
    return output;
  }

  private endMessage(): string {
    if (this.ended) return "";
    if (!this.started) fail(OAI_TO_ANT, "$stream", "[DONE] arrived before any chat chunk");
    if (this.finishReason === null) {
      fail(OAI_TO_ANT, "$stream", "OpenAI stream ended before a non-null finish_reason");
    }
    let output = this.stopContentBlocks();
    const usage: JsonObject = this.usage
      ? openAIUsageToAnthropic(this.usage)
      : { output_tokens: 0 };
    output += anthropicSse("message_delta", {
      type: "message_delta",
      delta: {
        stop_reason: this.finishReason,
        stop_sequence: null,
      },
      usage,
    });
    output += anthropicSse("message_stop", { type: "message_stop" });
    this.ended = true;
    return output;
  }
}

/** Byte transform for piping an Anthropic fetch body to an OpenAI client. */
export function createAnthropicToOpenAIChatSseTransform(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const converter = new AnthropicToOpenAIStreamConverter();
  const encoder = new TextEncoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = converter.feed(chunk);
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      const output = converter.finish();
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
  });
}

/** Byte transform for piping an OpenAI Chat fetch body to an Anthropic client. */
export function createOpenAIChatToAnthropicSseTransform(): TransformStream<
  Uint8Array,
  Uint8Array
> {
  const converter = new OpenAIToAnthropicStreamConverter();
  const encoder = new TextEncoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = converter.feed(chunk);
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      const output = converter.finish();
      if (output !== "") controller.enqueue(encoder.encode(output));
    },
  });
}

// Compact aliases retained for the historical converter API and easy proxy use.
export const oaiReqToAnt = convertOpenAIChatRequestToAnthropic;
export const antReqToOai = convertAnthropicRequestToOpenAIChat;
export const createAnthropicToOpenAiChatSseTransform =
  createAnthropicToOpenAIChatSseTransform;
export const createOpenAiChatToAnthropicSseTransform =
  createOpenAIChatToAnthropicSseTransform;

export function antRespToOai(text: string, model?: string): string {
  return JSON.stringify(
    convertAnthropicResponseToOpenAIChat(
      parseJsonObject(text, ANT_TO_OAI, "$response"),
      model
    )
  );
}

export function oaiRespToAnt(text: string, model?: string): string {
  return JSON.stringify(
    convertOpenAIChatResponseToAnthropic(
      parseJsonObject(text, OAI_TO_ANT, "$response"),
      model
    )
  );
}

export class AntStreamToOai extends AnthropicToOpenAIStreamConverter {}
export class OaiStreamToAnt extends OpenAIToAnthropicStreamConverter {}
