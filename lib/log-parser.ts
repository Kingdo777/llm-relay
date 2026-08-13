import type {
  LogRow,
  ParsedLogBlock,
  ParsedLogContent,
  ParsedLogEntry,
  Protocol,
} from "./types";

export const LOG_PARSER_VERSION = 6;
type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function textBlock(text: string, format: "markdown" | "plain" = "markdown"): ParsedLogBlock {
  return { type: "text", text, format };
}
function dataBlock(label: string, value: unknown): ParsedLogBlock {
  return { type: "data", label, value };
}
function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  return JSON.parse(raw);
}

function extractJsonArray(raw: string, key: string): unknown[] | null {
  const keyIndex = raw.indexOf(`"${key}"`);
  if (keyIndex < 0) return null;
  const start = raw.indexOf("[", keyIndex + key.length + 2);
  if (start < 0) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          const value = JSON.parse(raw.slice(start, index + 1));
          return Array.isArray(value) ? value : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractCompleteObjectsFromArray(raw: string, key: string): unknown[] {
  const keyIndex = raw.indexOf(`"${key}"`);
  if (keyIndex < 0) return [];
  const start = raw.indexOf("[", keyIndex + key.length + 2);
  if (start < 0) return [];

  const items: unknown[] = [];
  let arrayDepth = 0;
  let objectDepth = 0;
  let objectStart = -1;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "[") arrayDepth += 1;
    else if (char === "]") arrayDepth -= 1;
    else if (char === "{") {
      if (objectDepth === 0 && arrayDepth === 1) objectStart = index;
      objectDepth += 1;
    } else if (char === "}") {
      objectDepth -= 1;
      if (objectDepth === 0 && objectStart >= 0) {
        try {
          items.push(JSON.parse(raw.slice(objectStart, index + 1)));
        } catch {
          // 忽略不完整的尾部对象，保留此前已恢复的消息。
        }
        objectStart = -1;
      }
    }
  }
  return items;
}

function isSystemContextText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder>");
}

export function compactLogInput(raw: string, maxLength: number): string {
  try {
    const value = parseJson(raw);
    if (!isObject(value) || !Array.isArray(value.messages)) return raw.slice(0, maxLength);

    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const message = value.messages[index];
      if (!isObject(message) || message.role !== "user") continue;
      const texts = typeof message.content === "string"
        ? [message.content]
        : Array.isArray(message.content)
          ? message.content.flatMap((block) =>
              isObject(block) && block.type === "text" && typeof block.text === "string"
                ? [block.text]
                : []
            )
          : [];
      const text = texts.filter((item) => item && !isSystemContextText(item)).join("\n\n");
      if (!text) return JSON.stringify({ messages: [] });
      const suffix = text.length > maxLength ? `\n…[已截断，原始长度 ${text.length}]` : "";
      const content = text.length > maxLength
        ? text.slice(0, Math.max(0, maxLength - suffix.length)) + suffix
        : text;
      return JSON.stringify({ messages: [{ role: "user", content }] });
    }
    return JSON.stringify({ messages: [] });
  } catch {
    // 非 JSON 请求保留原始文本，仍受日志长度限制。
  }
  return raw.length <= maxLength
    ? raw
    : raw.slice(0, maxLength) + `\n…[已截断，原始长度 ${raw.length}]`;
}

function contentBlocks(content: unknown): ParsedLogBlock[] {
  if (typeof content === "string") return [textBlock(content)];
  if (!Array.isArray(content)) return content == null ? [] : [dataBlock("content", content)];
  return content.flatMap((block): ParsedLogBlock[] => {
    if (typeof block === "string") return [textBlock(block)];
    if (!isObject(block)) return [dataBlock("content", block)];
    if (block.type === "text" && typeof block.text === "string") return [textBlock(block.text)];
    if (block.type === "thinking" && typeof block.thinking === "string") return [textBlock(block.thinking, "plain")];
    if (block.type === "tool_use") return [{ type: "tool", name: String(block.name ?? "tool"), input: block.input }];
    if (block.type === "tool_result") return [{ type: "tool", name: "tool_result", output: block.content }];
    return [dataBlock(String(block.type ?? "content"), block)];
  });
}

function parseMessages(value: unknown): ParsedLogEntry[] {
  if (!isObject(value) || !Array.isArray(value.messages)) return [];
  return value.messages.flatMap((message): ParsedLogEntry[] => {
    if (!isObject(message)) return [];
    return [{ role: typeof message.role === "string" ? message.role : "message", blocks: contentBlocks(message.content) }];
  });
}

export function parseLogInput(raw: string | null): ParsedLogContent {
  if (!raw) return { entries: [] };
  try {
    const value = parseJson(raw);
    const entries = parseMessages(value);
    return entries.length
      ? { entries }
      : { entries: [{ role: "request", blocks: [dataBlock("request", value)] }] };
  } catch {
    const messages = extractJsonArray(raw, "messages")
      ?? extractCompleteObjectsFromArray(raw, "messages");
    if (messages) {
      const entries = parseMessages({ messages });
      if (entries.length) {
        return { entries, warnings: ["请求日志被截断，已恢复其中完整的 messages 内容。"] };
      }
    }
    return { entries: [{ role: "request", blocks: [textBlock(raw)] }], warnings: ["请求体不是完整 JSON，已按原始文本展示。"] };
  }
}

interface SseEvent { data: string }
function parseSse(raw: string): { events: SseEvent[]; truncated: boolean } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const chunks = normalized.split("\n\n");
  const truncated = !normalized.endsWith("\n\n");
  const events: SseEvent[] = [];
  for (const chunk of chunks) {
    const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    if (data) events.push({ data });
  }
  return { events, truncated };
}
function parseToolJson(raw: string): unknown {
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
}

function parseOpenAiStream(raw: string): ParsedLogContent {
  const { events, truncated } = parseSse(raw);
  const texts = new Map<number, string>();
  const reasoning = new Map<number, string>();
  const tools = new Map<number, { name: string; args: string }>();
  const warnings: string[] = [];
  for (const event of events) {
    if (event.data === "[DONE]") continue;
    try {
      const value = JSON.parse(event.data) as JsonObject;
      const choices = Array.isArray(value.choices) ? value.choices : [];
      for (const choice of choices) {
        if (!isObject(choice)) continue;
        const index = typeof choice.index === "number" ? choice.index : 0;
        const delta = isObject(choice.delta) ? choice.delta : {};
        if (typeof delta.content === "string") texts.set(index, (texts.get(index) ?? "") + delta.content);
        if (typeof delta.reasoning_content === "string") {
          reasoning.set(index, (reasoning.get(index) ?? "") + delta.reasoning_content);
        }
        if (Array.isArray(delta.tool_calls)) for (const call of delta.tool_calls) {
          if (!isObject(call)) continue;
          const toolIndex = typeof call.index === "number" ? call.index : tools.size;
          const fn = isObject(call.function) ? call.function : {};
          const current = tools.get(toolIndex) ?? { name: "tool", args: "" };
          if (typeof fn.name === "string") current.name = fn.name;
          if (typeof fn.arguments === "string") current.args += fn.arguments;
          tools.set(toolIndex, current);
        }
      }
    } catch { warnings.push("部分 OpenAI SSE 事件不是完整 JSON，已跳过。"); }
  }
  const blocks: ParsedLogBlock[] = [...reasoning]
    .sort(([a], [b]) => a - b)
    .filter(([, text]) => text)
    .map(([, text]) => textBlock(text, "plain"));
  blocks.push(
    ...[...texts]
      .sort(([a], [b]) => a - b)
      .filter(([, text]) => text)
      .map(([, text]) => textBlock(text))
  );
  blocks.push(
    ...[...tools]
      .sort(([a], [b]) => a - b)
      .map(([, tool]): ParsedLogBlock => ({
        type: "tool",
        name: tool.name,
        input: parseToolJson(tool.args),
      }))
  );
  if (truncated) warnings.push("流式日志可能已截断，展示的是已成功解析的部分。");
  return { entries: [{ role: "assistant", blocks }], warnings };
}

function parseAnthropicStream(raw: string): ParsedLogContent {
  const { events, truncated } = parseSse(raw);
  const blocks = new Map<number, ParsedLogBlock>();
  const toolArgs = new Map<number, { name: string; args: string }>();
  const warnings: string[] = [];
  for (const event of events) {
    try {
      const value = JSON.parse(event.data) as JsonObject;
      if (value.type === "content_block_start") {
        const index = typeof value.index === "number" ? value.index : blocks.size;
        const block = isObject(value.content_block) ? value.content_block : {};
        if (block.type === "text") blocks.set(index, textBlock(typeof block.text === "string" ? block.text : ""));
        else if (block.type === "thinking") blocks.set(index, textBlock(typeof block.thinking === "string" ? block.thinking : "", "plain"));
        else if (block.type === "tool_use") toolArgs.set(index, { name: String(block.name ?? "tool"), args: "" });
        else blocks.set(index, dataBlock(String(block.type ?? "content"), block));
      } else if (value.type === "content_block_delta") {
        const index = typeof value.index === "number" ? value.index : 0;
        const delta = isObject(value.delta) ? value.delta : {};
        if (delta.type === "text_delta" || delta.type === "thinking_delta") {
          const current = blocks.get(index);
          const addition = typeof delta.text === "string" ? delta.text : typeof delta.thinking === "string" ? delta.thinking : "";
          if (current?.type === "text") current.text += addition;
          else blocks.set(index, textBlock(addition));
        } else if (delta.type === "input_json_delta") {
          const current = toolArgs.get(index) ?? { name: "tool", args: "" };
          if (typeof delta.partial_json === "string") current.args += delta.partial_json;
          toolArgs.set(index, current);
        }
      }
    } catch { warnings.push("部分 Anthropic SSE 事件不是完整 JSON，已跳过。"); }
  }
  for (const [index, tool] of toolArgs) blocks.set(index, { type: "tool", name: tool.name, input: parseToolJson(tool.args) });
  if (truncated) warnings.push("流式日志可能已截断，展示的是已成功解析的部分。");
  return { entries: [{ role: "assistant", blocks: [...blocks].sort(([a], [b]) => a - b).map(([, block]) => block) }], warnings };
}

function parseJsonResponse(value: unknown): ParsedLogContent {
  if (!isObject(value)) return { entries: [{ role: "response", blocks: [dataBlock("response", value)] }] };
  if (Array.isArray(value.choices)) {
    const entries = value.choices.flatMap((choice): ParsedLogEntry[] => {
      if (!isObject(choice) || !isObject(choice.message)) return [];
      const blocks: ParsedLogBlock[] = [];
      if (typeof choice.message.reasoning_content === "string" && choice.message.reasoning_content) {
        blocks.push(textBlock(choice.message.reasoning_content, "plain"));
      }
      blocks.push(...contentBlocks(choice.message.content));
      if (Array.isArray(choice.message.tool_calls)) for (const call of choice.message.tool_calls) {
        if (!isObject(call)) continue;
        const fn = isObject(call.function) ? call.function : {};
        blocks.push({ type: "tool", name: String(fn.name ?? "tool"), input: typeof fn.arguments === "string" ? parseToolJson(fn.arguments) : fn.arguments });
      }
      return [{ role: String(choice.message.role ?? "assistant"), blocks }];
    });
    return { entries, metadata: { model: value.model, usage: value.usage } };
  }
  if (Array.isArray(value.content)) return { entries: [{ role: String(value.role ?? "assistant"), blocks: contentBlocks(value.content) }], metadata: { model: value.model, usage: value.usage, stop_reason: value.stop_reason } };
  return { entries: [{ role: "response", blocks: [dataBlock("response", value)] }] };
}

function detectSseProtocol(raw: string, fallback: Protocol): Protocol {
  const { events } = parseSse(raw);
  for (const event of events) {
    if (event.data === "[DONE]") continue;
    try {
      const value = JSON.parse(event.data) as unknown;
      if (!isObject(value)) continue;
      if (Array.isArray(value.choices) || value.object === "chat.completion.chunk") {
        return "openai";
      }
      if (
        typeof value.type === "string" &&
        (value.type.startsWith("message_") || value.type.startsWith("content_block_"))
      ) {
        return "anthropic";
      }
    } catch {
      // 继续检查后续事件，无法识别时使用请求协议兜底。
    }
  }
  return fallback;
}

export function parseLogOutput(raw: string | null, protocol: Protocol): ParsedLogContent {
  if (!raw) return { entries: [] };
  const trimmed = raw.trimStart();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    return detectSseProtocol(raw, protocol) === "anthropic"
      ? parseAnthropicStream(raw)
      : parseOpenAiStream(raw);
  }
  try { return parseJsonResponse(parseJson(raw)); }
  catch { return { entries: [{ role: "response", blocks: [textBlock(raw)] }], warnings: ["响应不是完整 JSON 或 SSE，已按原始文本展示。"] }; }
}

export function parseLog(log: LogRow) {
  return { parsedInput: parseLogInput(log.input), parsedOutput: parseLogOutput(log.output, log.protocol) };
}
