import type {
  LogRow,
  ParsedLogBlock,
  ParsedLogContent,
  ParsedLogEntry,
  Protocol,
} from "./types";

export const LOG_PARSER_VERSION = 9;
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

/**
 * Claude Code / agent 客户端注入到 user 消息里的包装标签。这些不是用户输入，
 * 日志压缩时应整体剥离，只保留真实文本。
 */
const INJECTED_TAGS = [
  "system-reminder",
  "local-command-caveat",
  "command-name",
  "command-message",
  "command-args",
  "local-command-stdout",
  "total_tokens",
];

/**
 * 剥离注入的 <tag>...</tag> 包装块（可多条、可跨行），保留其余真实文本。
 *
 * 旧实现只处理 <system-reminder>，且"整条以标签开头就丢弃"，导致 Claude Code
 * 这类把注入上下文放在 user 消息开头的客户端，其真实问题被一并清空（日志 input
 * 变成 {"messages":[]}），或被 local-command 包装淹没。改为只剥离标签块，
 * 保留块外的真实文本。
 */
function stripInjectedBlocks(text: string): string {
  let out = text;
  for (const tag of INJECTED_TAGS) {
    out = out.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  }
  return out.trim();
}

/**
 * 从消息 content 收集文本块，兼容 OpenAI / Anthropic 三种形态：
 * 字符串、文本块数组（text 与 tool_result 混排）、单对象（Anthropic 新格式 {type:"text",text}）。
 */
function collectUserTexts(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (Array.isArray(content)) {
    return content.flatMap((block) => {
      if (typeof block === "string") return [block];
      if (isObject(block) && block.type === "text" && typeof block.text === "string") {
        return [block.text];
      }
      return [];
    });
  }
  if (isObject(content) && content.type === "text" && typeof content.text === "string") {
    return [content.text];
  }
  return [];
}

export function compactLogInput(raw: string, maxLength: number): string {
  try {
    const value = parseJson(raw);
    if (!isObject(value) || !Array.isArray(value.messages)) return raw.slice(0, maxLength);

    for (let index = value.messages.length - 1; index >= 0; index -= 1) {
      const message = value.messages[index];
      if (!isObject(message) || message.role !== "user") continue;
      // 只取最新一条 user 消息；剥离注入的包装块后，
      // 若无真实文本（如纯 tool_result / 纯注入上下文）则返回空，不回退历史消息。
      const text = collectUserTexts(message.content)
        .map(stripInjectedBlocks)
        .filter(Boolean)
        .join("\n\n");
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
    let messages = extractJsonArray(raw, "messages");
    if (!messages?.length) messages = extractCompleteObjectsFromArray(raw, "messages");
    if (!messages?.length) messages = extractJsonArray(raw, "input");
    if (!messages?.length) messages = extractCompleteObjectsFromArray(raw, "input");
    if (messages?.length) {
      const entries = parseMessages({ messages });
      if (entries.length) {
        return { entries, warnings: ["请求日志被截断，已恢复其中完整的 messages/input 内容。"] };
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

/**
 * 解析 OpenAI Responses API 的 SSE 流。
 *
 * Responses 的事件类型以 `response.` 前缀出现，与 Chat Completions 的
 * `chat.completion.chunk` 结构不同。这里累积：
 *   - response.output_text.delta            → 正文
 *   - response.reasoning_*_text.delta      → 推理摘要
 *   - response.output_item.added            → function_call 的名字
 *   - response.function_call_arguments.delta→ function_call 的参数
 */
function parseOpenAiResponsesStream(raw: string): ParsedLogContent {
  const { events, truncated } = parseSse(raw);
  const texts = new Map<number, string>();
  const reasoning = new Map<number, string>();
  const tools = new Map<string, { name: string; args: string }>();
  const toolOrder: string[] = [];
  const warnings: string[] = [];
  for (const event of events) {
    if (event.data === "[DONE]") continue;
    try {
      const value = JSON.parse(event.data) as JsonObject;
      const type = typeof value.type === "string" ? value.type : "";

      if (type === "response.output_item.added") {
        const item = isObject(value.item) ? value.item : {};
        if (item.type === "function_call") {
          const id = typeof item.id === "string" ? item.id : `tool_${toolOrder.length}`;
          if (!tools.has(id)) {
            toolOrder.push(id);
            tools.set(id, {
              name: typeof item.name === "string" ? item.name : "tool",
              args: typeof item.arguments === "string" ? item.arguments : "",
            });
          }
        }
      } else if (type === "response.function_call_arguments.delta") {
        const id = typeof value.item_id === "string" ? value.item_id
          : (toolOrder[toolOrder.length - 1] ?? "tool");
        const delta = typeof value.delta === "string" ? value.delta : "";
        const current = tools.get(id) ?? { name: "tool", args: "" };
        if (!tools.has(id)) toolOrder.push(id);
        current.args += delta;
        tools.set(id, current);
      } else if (type === "response.output_text.delta") {
        const idx = typeof value.output_index === "number" ? value.output_index : 0;
        if (typeof value.delta === "string") {
          texts.set(idx, (texts.get(idx) ?? "") + value.delta);
        }
      } else if (
        type === "response.reasoning_summary_text.delta" ||
        type === "response.reasoning_text.delta"
      ) {
        const idx = typeof value.output_index === "number" ? value.output_index : 0;
        if (typeof value.delta === "string") {
          reasoning.set(idx, (reasoning.get(idx) ?? "") + value.delta);
        }
      }
    } catch { warnings.push("部分 Responses SSE 事件不是完整 JSON，已跳过。"); }
  }
  // Fallback: 从 response.completed 事件提取最终内容
  for (const event of events) {
    if (event.data === "[DONE]") continue;
    try {
      const value = JSON.parse(event.data) as JsonObject;
      if (value.type === "response.completed" && isObject(value.response)) {
        const resp = value.response as JsonObject;
        if (Array.isArray(resp.output)) {
          for (const item of resp.output) {
            if (!isObject(item)) continue;
            if (item.type === "message" && Array.isArray(item.content)) {
              for (const part of item.content) {
                if (isObject(part) && (part.type === "output_text" || part.type === "text") && typeof part.text === "string" && part.text) {
                  const idx = 0;
                  if (!(texts.get(idx) ?? "")) texts.set(idx, part.text);
                }
              }
            }
            if (item.type === "reasoning" && Array.isArray(item.summary)) {
              for (const s of item.summary) {
                if (isObject(s) && typeof s.text === "string" && s.text) {
                  const idx = 0;
                  if (!(reasoning.get(idx) ?? "")) reasoning.set(idx, s.text);
                }
              }
            }
          }
        }
      }
    } catch { /* already warned above */ }
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
    ...toolOrder
      .map((id) => tools.get(id))
      .filter((tool): tool is { name: string; args: string } => !!tool)
      .map((tool): ParsedLogBlock => ({
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
  // OpenAI Responses 非流式响应：{ object: "response", output: [ {type:"message"|"function_call"|"reasoning"} ] }
  if (value.object === "response" && Array.isArray(value.output)) {
    const blocks: ParsedLogBlock[] = [];
    for (const item of value.output) {
      if (!isObject(item)) continue;
      if (item.type === "reasoning" && Array.isArray(item.summary)) {
        for (const s of item.summary) {
          if (isObject(s) && typeof s.text === "string") blocks.push(textBlock(s.text, "plain"));
        }
      } else if (item.type === "message" && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (isObject(part) && typeof part.text === "string") blocks.push(textBlock(part.text));
        }
      } else if (item.type === "function_call") {
        const args = typeof item.arguments === "string" ? item.arguments : "";
        blocks.push({ type: "tool", name: String(item.name ?? "tool"), input: parseToolJson(args) });
      }
    }
    return {
      entries: [{ role: "assistant", blocks }],
      metadata: { model: value.model, usage: value.usage, status: value.status },
    };
  }
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
      if (typeof value.type === "string" && value.type.startsWith("response.")) {
        return "openai-responses";
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
    const proto = detectSseProtocol(raw, protocol);
    if (proto === "anthropic") return parseAnthropicStream(raw);
    if (proto === "openai-responses") return parseOpenAiResponsesStream(raw);
    return parseOpenAiStream(raw);
  }
  try { return parseJsonResponse(parseJson(raw)); }
  catch { return { entries: [{ role: "response", blocks: [textBlock(raw)] }], warnings: ["响应不是完整 JSON 或 SSE，已按原始文本展示。"] }; }
}

export function parseLog(log: LogRow) {
  return { parsedInput: parseLogInput(log.input), parsedOutput: parseLogOutput(log.output, log.protocol) };
}
