import type { Protocol } from "./types";

/* =========================================================================
 * 格式转换引擎：OpenAI ⇄ Anthropic
 *
 * 覆盖：
 *   - 请求体（messages / system / tools / tool_choice / max_tokens /
 *     stop / temperature / top_p / stream）
 *   - 非流式响应（choices → content，usage 字段映射）
 *   - 流式 SSE chunk（OpenAI delta ↔ Anthropic event）
 *
 * 不覆盖：图像/音频 content、function calling 的旧版 functions 字段、
 *         response_format(json_schema)、parallel_tool_calls 等较新或较少用字段。
 *         这些在透传时若无法映射则忽略，保证主流场景可用。
 * ======================================================================= */

// ---- 通用类型（仅用于转换内部）----
interface OaiMessage {
  role?: string;
  content?: string | Array<{ type: string; text?: string }>;
  tool_calls?: Array<{
    id: string;
    type: string;
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}
interface OaiRequestBody {
  model?: string;
  messages?: OaiMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  stream?: boolean;
  tools?: Array<{
    type: string;
    function: { name: string; description?: string; parameters?: unknown };
  }>;
  tool_choice?: string | object;
}
interface AntMessage {
  role: string;
  content: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
}
interface AntRequestBody {
  model?: string;
  messages?: AntMessage[];
  system?: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: Array<{
    name: string;
    description?: string;
    input_schema?: unknown;
  }>;
  tool_choice?: { type: string; name?: string } | string;
}

/* ---------------- 请求体转换 ---------------- */

/** OpenAI 请求体 → Anthropic 请求体 */
export function oaiReqToAnt(body: OaiRequestBody): AntRequestBody {
  const out: AntRequestBody = { max_tokens: 1024 };
  if (body.model) out.model = body.model;
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream) out.stream = true;
  if (typeof body.stop === "string") out.stop_sequences = [body.stop];
  else if (Array.isArray(body.stop)) out.stop_sequences = body.stop;

  // tools
  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t) => t?.function?.name)
      .map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters || { type: "object", properties: {} },
      }));
  }
  // tool_choice
  if (body.tool_choice === "auto" || body.tool_choice === "none") {
    out.tool_choice = { type: body.tool_choice };
  } else if (body.tool_choice === "required") {
    out.tool_choice = { type: "any" };
  } else if (
    body.tool_choice &&
    typeof body.tool_choice === "object" &&
    (body.tool_choice as { function?: { name?: string } }).function?.name
  ) {
    out.tool_choice = {
      type: "tool",
      name: (body.tool_choice as { function: { name: string } }).function.name,
    } as { type: string; name?: string };
  }

  // messages：把 role=system 的提取为顶层 system，其余转换
  const msgs = body.messages || [];
  const systems: string[] = [];
  const outMsgs: AntMessage[] = [];
  for (const m of msgs) {
    if (m.role === "system") {
      systems.push(contentToString(m.content));
    } else if (m.role === "tool") {
      // OpenAI tool 结果 → Anthropic user 消息 + tool_result block
      outMsgs.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: m.tool_call_id || "",
            content: contentToString(m.content),
          },
        ],
      });
    } else if (m.role === "assistant" && m.tool_calls) {
      // assistant 带 tool_calls → content 数组里放 tool_use 块
      const blocks: Array<{
        type: string;
        text?: string;
        [k: string]: unknown;
      }> = [];
      const text = contentToString(m.content);
      if (text) blocks.push({ type: "text", text });
      for (const tc of m.tool_calls) {
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: safeJsonParse(tc.function.arguments, {}),
        });
      }
      outMsgs.push({ role: "assistant", content: blocks });
    } else {
      outMsgs.push({
        role: m.role || "user",
        content: contentToString(m.content),
      });
    }
  }
  if (systems.length) out.system = systems.join("\n\n");
  out.messages = outMsgs;
  return out;
}

/** Anthropic 请求体 → OpenAI 请求体 */
export function antReqToOai(body: AntRequestBody): OaiRequestBody {
  const out: OaiRequestBody = {};
  if (body.model) out.model = body.model;
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  if (body.top_p !== undefined) out.top_p = body.top_p;
  if (body.stream) out.stream = true;
  if (Array.isArray(body.stop_sequences)) {
    out.stop =
      body.stop_sequences.length === 1
        ? body.stop_sequences[0]
        : body.stop_sequences;
  }

  // tools
  if (Array.isArray(body.tools)) {
    out.tools = body.tools
      .filter((t) => t?.name)
      .map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema || { type: "object", properties: {} },
        },
      }));
  }
  if (body.tool_choice) {
    const tc = body.tool_choice;
    if (typeof tc === "string") out.tool_choice = tc;
    else if (tc.type === "any") out.tool_choice = "required";
    else if (tc.type === "auto" || tc.type === "none")
      out.tool_choice = tc.type;
    else if (tc.type === "tool" && tc.name)
      out.tool_choice = { type: "function", function: { name: tc.name } };
  }

  const msgs = body.messages || [];
  const outMsgs: OaiMessage[] = [];
  if (body.system) outMsgs.push({ role: "system", content: body.system });

  for (const m of msgs) {
    if (typeof m.content === "string") {
      outMsgs.push({ role: m.role, content: m.content });
      continue;
    }
    // content 是数组：拆出 text / tool_use / tool_result
    const blocks = m.content || [];
    const textParts: string[] = [];
    const toolCalls: OaiMessage["tool_calls"] = [];
    const toolResults: Array<{ id: string; content: string }> = [];
    for (const b of blocks) {
      if (b.type === "text" && b.text) textParts.push(b.text);
      else if (b.type === "tool_use")
        toolCalls.push({
          id: b.id as string,
          type: "function",
          function: {
            name: b.name as string,
            arguments: JSON.stringify(b.input ?? {}),
          },
        });
      else if (b.type === "tool_result")
        toolResults.push({
          id: b.tool_use_id as string,
          content: blockContentToString(b),
        });
    }
    if (m.role === "assistant") {
      const am: OaiMessage = {
        role: "assistant",
        content: textParts.join("") || null!,
      };
      if (toolCalls.length) am.tool_calls = toolCalls;
      outMsgs.push(am);
    } else if (toolResults.length) {
      // user 带工具结果 → OpenAI role=tool
      for (const tr of toolResults) {
        outMsgs.push({
          role: "tool",
          tool_call_id: tr.id,
          content: tr.content,
        });
      }
      // 若还有文本，作为 user 消息追加
      if (textParts.length)
        outMsgs.push({ role: "user", content: textParts.join("") });
    } else {
      outMsgs.push({ role: m.role, content: textParts.join("") });
    }
  }
  out.messages = outMsgs;
  return out;
}

/* ---------------- 非流式响应转换 ---------------- */

/** Anthropic 响应 → OpenAI 响应 */
export function antRespToOai(text: string, model?: string): string {
  try {
    const a = JSON.parse(text);
    const oai = {
      id: a.id || "chatcmpl-relay",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: a.model || model || "",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: antContentToText(a.content) },
          finish_reason: mapStopReason(a.stop_reason),
        },
      ],
      usage: {
        prompt_tokens: a.usage?.input_tokens || 0,
        completion_tokens: a.usage?.output_tokens || 0,
        total_tokens:
          (a.usage?.input_tokens || 0) + (a.usage?.output_tokens || 0),
      },
    };
    return JSON.stringify(oai);
  } catch {
    return text; // 无法解析，原样返回
  }
}

/** OpenAI 响应 → Anthropic 响应 */
export function oaiRespToAnt(text: string, model?: string): string {
  try {
    const o = JSON.parse(text);
    const msg = o.choices?.[0]?.message;
    const ant = {
      id: o.id || "msg_relay",
      type: "message",
      role: "assistant",
      model: o.model || model || "",
      content: [{ type: "text", text: msg?.content || "" }],
      stop_reason: mapFinishReason(msg?.finish_reason ?? o.choices?.[0]?.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: o.usage?.prompt_tokens || 0,
        output_tokens: o.usage?.completion_tokens || 0,
      },
    };
    return JSON.stringify(ant);
  } catch {
    return text;
  }
}

/* ---------------- 流式 chunk 转换 ----------------
 * 流式跨格式是最复杂的部分。两种格式的事件序列不同：
 *   OpenAI:  data: {choices:[{delta:{content:"x"}}]} ... data:[DONE]
 *   Anthropic: message_start / content_block_start / content_block_delta* /
 *              content_block_stop / message_delta / message_stop
 *
 * 转换策略：用一个状态机，按上游协议的流式规范解析，
 * 翻译成目标协议的流式事件序列。
 * ---------------------------------------------------------------------- */

interface OaiStreamState {
  started: boolean;
  msgId: string;
  model: string;
}

/** Anthropic 流式 chunk(s) → OpenAI SSE 行（可能一条 Anthropic delta 产生多条 OpenAI data 行）*/
export class AntStreamToOai {
  private state: OaiStreamState = { started: false, msgId: "", model: "" };
  private blockIndex = -1;

  /** 输入一段原始 SSE 文本（可能含多个 event），返回拼出的 OpenAI SSE 行 */
  feed(raw: string): string {
    const out: string[] = [];
    const events = splitSseEvents(raw);
    for (const ev of events) {
      if (!ev.data) continue;
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const type = (data.type || ev.event) as string;

      if (type === "message_start") {
        const msg = (data.message || {}) as Record<string, unknown>;
        this.state.msgId = (msg.id as string) || "chatcmpl-relay";
        this.state.model = (msg.model as string) || "";
        this.state.started = true;
        // OpenAI 通常以一个带 role 的首 chunk 开头
        out.push(
          this.oaiChunk({ role: "assistant" }, null)
        );
      } else if (type === "content_block_start") {
        this.blockIndex = (data.index as number) ?? 0;
        const cb = (data.content_block || {}) as Record<string, unknown>;
        if (cb.type === "text" && cb.text) {
          out.push(this.oaiChunk({ content: cb.text as string }, null));
        }
      } else if (type === "content_block_delta") {
        const delta = (data.delta || {}) as Record<string, unknown>;
        if (delta.type === "text_delta" && delta.text) {
          out.push(this.oaiChunk({ content: delta.text as string }, null));
        }
        // tool_use 等暂不转流式
      } else if (type === "content_block_stop") {
        // OpenAI 无对应事件，跳过
      } else if (type === "message_delta") {
        const delta = (data.delta || {}) as Record<string, unknown>;
        if (delta.stop_reason) {
          out.push(this.oaiChunk({}, mapStopReason(delta.stop_reason as string)));
        }
        if ((data.usage as { output_tokens?: number } | undefined)?.output_tokens) {
          // OpenAI 流式末尾常带 usage（若客户端请求 stream_options.include_usage）
          // 这里不发 usage chunk 以保持简单，多数客户端不依赖
        }
      } else if (type === "message_stop") {
        out.push("data: [DONE]\n\n");
      }
    }
    return out.join("");
  }

  private oaiChunk(delta: Record<string, unknown>, finish: string | null): string {
    const choices = [
      {
        index: 0,
        delta,
        finish_reason: finish,
      },
    ];
    const chunk = {
      id: this.state.msgId || "chatcmpl-relay",
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: this.state.model,
      choices,
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  }
}

/** OpenAI 流式 chunk(s) → Anthropic SSE 事件行 */
export class OaiStreamToAnt {
  private started = false;
  private msgId = "";
  private model = "";
  private blockStarted = false;
  private blockIndex = 0;
  private outputTokens = 0;

  feed(raw: string): string {
    const out: string[] = [];
    const events = splitSseEvents(raw);
    for (const ev of events) {
      if (ev.data === "[DONE]") {
        // 收尾
        if (this.blockStarted) {
          out.push(this.antEvent("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
        }
        out.push(
          this.antEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
          })
        );
        out.push(this.antEvent("message_stop", { type: "message_stop" }));
        continue;
      }
      let data: Record<string, unknown>;
      try {
        data = JSON.parse(ev.data);
      } catch {
        continue;
      }
      const choices = (data.choices as Array<Record<string, unknown>>) || [];
      const choice = choices[0] || {};
      const delta = (choice.delta as Record<string, unknown>) || {};
      const finish = choice.finish_reason as string | undefined;

      if (!this.started) {
        this.msgId = (data.id as string) || "msg_relay";
        this.model = (data.model as string) || "";
        this.started = true;
        out.push(
          this.antEvent("message_start", {
            type: "message_start",
            message: {
              id: this.msgId,
              type: "message",
              role: "assistant",
              model: this.model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          })
        );
      }

      // role only（首个 chunk 常带 role）
      if (delta.role && !delta.content) {
        // Anthropic 不需要单独的 role 事件，等第一个 text
        continue;
      }
      if (typeof delta.content === "string" && delta.content) {
        if (!this.blockStarted) {
          this.blockStarted = true;
          out.push(
            this.antEvent("content_block_start", {
              type: "content_block_start",
              index: this.blockIndex,
              content_block: { type: "text", text: "" },
            })
          );
        }
        this.outputTokens += Math.max(1, Math.ceil(delta.content.length / 4));
        out.push(
          this.antEvent("content_block_delta", {
            type: "content_block_delta",
            index: this.blockIndex,
            delta: { type: "text_delta", text: delta.content },
          })
        );
      }
      if (finish) {
        // finish 会在 [DONE] 之前的最后一个 chunk 或单独出现
        if (this.blockStarted) {
          out.push(this.antEvent("content_block_stop", { type: "content_block_stop", index: this.blockIndex }));
          this.blockStarted = false;
        }
        out.push(
          this.antEvent("message_delta", {
            type: "message_delta",
            delta: { stop_reason: mapFinishReason(finish), stop_sequence: null },
            usage: { output_tokens: this.outputTokens },
          })
        );
        out.push(this.antEvent("message_stop", { type: "message_stop" }));
      }
    }
    return out.join("");
  }

  private antEvent(event: string, data: Record<string, unknown>): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }
}

/* ---------------- 工具函数 ---------------- */

function contentToString(
  c: string | Array<{ type: string; text?: string }> | undefined
): string {
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((b) => (b.type === "text" ? b.text || "" : ""))
      .join("");
  return "";
}

function blockContentToString(b: Record<string, unknown>): string {
  // tool_result 的 content 可能是 string 或 [{type:text,text}]
  const c = b.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c))
    return c
      .map((x) =>
        typeof x === "string" ? x : (x as { text?: string })?.text || ""
      )
      .join("");
  return "";
}

function antContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .map((b: Record<string, unknown>) =>
        b.type === "text" ? (b.text as string) || "" : ""
      )
      .join("");
  return "";
}

function safeJsonParse(s: string, fallback: unknown): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
}

function mapStopReason(r: string | undefined): string {
  switch (r) {
    case "end_turn":
    case "stop_sequence":
      return "stop";
    case "max_tokens":
      return "length";
    case "tool_use":
      return "tool_calls";
    default:
      return r || "stop";
  }
}

function mapFinishReason(r: string | undefined): string {
  switch (r) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
      return "tool_use";
    default:
      return r || "end_turn";
  }
}

/** 把 SSE 原始文本拆成 {event, data} 数组 */
function splitSseEvents(raw: string): { event: string; data: string }[] {
  const events: { event: string; data: string }[] = [];
  // SSE 事件以空行分隔
  const blocks = raw.split(/\n\s*\n/);
  for (const block of blocks) {
    let event = "message";
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length) {
      events.push({ event, data: dataLines.join("\n") });
    }
  }
  return events;
}
