/**
 * OpenAI Responses <-> Anthropic Messages compatibility helpers.
 *
 * This module intentionally has no dependency on the relay/database layer.  It
 * converts only the subset that has a lossless Anthropic equivalent: text and
 * client-side function tools.  Stateful Responses features and hosted tools
 * fail loudly instead of being silently ignored.
 */

type JsonObject = Record<string, unknown>;

const MAX_SSE_BUFFER = 1024 * 1024;
const MAX_STREAM_ITEMS = 256;
const MAX_STREAM_CONTENT = 4 * 1024 * 1024;
const MAX_STREAM_TOTAL_CONTENT = 16 * 1024 * 1024;

export class ConversionError extends Error {
  readonly code: string;
  readonly field?: string;
  readonly status = 422;

  constructor(message: string, code = "unsupported_conversion", field?: string) {
    super(message);
    this.name = "ConversionError";
    this.code = code;
    this.field = field;
  }
}

export interface ResponsesConversionOptions {
  /** Override the generated Responses id (useful for deterministic tests). */
  responseId?: string;
  /** Unix seconds. Defaults to the current time. */
  createdAt?: number;
  /** Model to expose when the Anthropic payload has no model. */
  model?: string;
  /** Original Responses request, used only to echo response metadata. */
  request?: JsonObject;
  /** Default Anthropic max_tokens when max_output_tokens was omitted. */
  defaultMaxTokens?: number;
}

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConversionError(`${label} 必须是 JSON 对象`, "invalid_payload", label);
  }
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) {
    throw new ConversionError(`${field} 必须是非空字符串`, "invalid_payload", field);
  }
  return value;
}

function rejectField(body: JsonObject, field: string, message: string): void {
  if (body[field] !== undefined && body[field] !== null && body[field] !== false) {
    throw new ConversionError(message, "unsupported_responses_feature", field);
  }
}

function contentToTextBlocks(content: unknown, field: string): JsonObject[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) {
    throw new ConversionError(`${field} 仅支持文本`, "unsupported_content", field);
  }
  return content.map((raw, index) => {
    const block = objectValue(raw, `${field}[${index}]`);
    if (
      (block.type === "input_text" || block.type === "output_text" || block.type === "text") &&
      typeof block.text === "string"
    ) {
      return { type: "text", text: block.text };
    }
    throw new ConversionError(
      `${field}[${index}] 的 ${String(block.type ?? "未知")} 内容无法转换；仅支持文本`,
      "unsupported_content",
      `${field}[${index}]`
    );
  });
}

function toolResultContent(output: unknown, field: string): string | JsonObject[] {
  if (typeof output === "string") return output;
  if (output === null || output === undefined) return "";
  if (Array.isArray(output)) return contentToTextBlocks(output, field);
  // The Responses schema normally requires a string, but accepting an object is
  // useful for hand-written clients and remains lossless after serialization.
  if (typeof output === "object" || typeof output === "number" || typeof output === "boolean") {
    return JSON.stringify(output);
  }
  throw new ConversionError(`${field} 无法转换为工具结果`, "unsupported_content", field);
}

function parseFunctionArguments(value: unknown, field: string): JsonObject {
  if (optionalObject(value)) return value as JsonObject;
  if (typeof value !== "string") {
    throw new ConversionError(`${field} 必须是 JSON 字符串`, "invalid_function_arguments", field);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value || "{}");
  } catch {
    throw new ConversionError(`${field} 不是合法 JSON`, "invalid_function_arguments", field);
  }
  if (!optionalObject(parsed)) {
    throw new ConversionError(`${field} 必须解析为 JSON 对象`, "invalid_function_arguments", field);
  }
  return parsed as JsonObject;
}

function mapResponsesTools(value: unknown): JsonObject[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ConversionError("tools 必须是数组", "invalid_payload", "tools");
  }
  const names = new Set<string>();
  return value.map((raw, index) => {
    const tool = objectValue(raw, `tools[${index}]`);
    if (tool.type !== "function") {
      throw new ConversionError(
        `Responses 托管工具 ${String(tool.type ?? "未知")} 无法路由到 Anthropic；仅支持自定义 function`,
        "unsupported_hosted_tool",
        `tools[${index}]`
      );
    }
    const name = requiredString(tool.name, `tools[${index}].name`);
    if (names.has(name)) {
      throw new ConversionError(
        `tools 中存在重复函数名 ${name}`,
        "invalid_payload",
        `tools[${index}].name`
      );
    }
    names.add(name);
    if (
      tool.parameters !== undefined &&
      tool.parameters !== null &&
      !optionalObject(tool.parameters)
    ) {
      throw new ConversionError(
        `tools[${index}].parameters 必须是对象`,
        "invalid_payload",
        `tools[${index}].parameters`
      );
    }
    if (tool.strict !== undefined && typeof tool.strict !== "boolean") {
      throw new ConversionError(
        `tools[${index}].strict 必须是布尔值`,
        "invalid_payload",
        `tools[${index}].strict`
      );
    }
    const result: JsonObject = {
      name,
      input_schema: optionalObject(tool.parameters) ?? { type: "object", properties: {} },
    };
    if (tool.description !== undefined && typeof tool.description !== "string") {
      throw new ConversionError(
        `tools[${index}].description 必须是字符串`,
        "invalid_payload",
        `tools[${index}].description`
      );
    }
    if (typeof tool.description === "string") result.description = tool.description;
    // Current Anthropic versions understand strict client tools. Preserve it
    // when supplied, but do not invent it for older upstreams.
    if (typeof tool.strict === "boolean") result.strict = tool.strict;
    return result;
  });
}

function mapToolChoice(value: unknown, parallel: unknown): JsonObject | undefined {
  if (value === undefined || value === null) {
    return parallel === false ? { type: "auto", disable_parallel_tool_use: true } : undefined;
  }

  let result: JsonObject;
  if (value === "auto") result = { type: "auto" };
  else if (value === "none") result = { type: "none" };
  else if (value === "required") result = { type: "any" };
  else {
    const choice = objectValue(value, "tool_choice");
    if (choice.type !== "function") {
      throw new ConversionError(
        `tool_choice ${String(choice.type ?? "未知")} 无法转换`,
        "unsupported_hosted_tool",
        "tool_choice"
      );
    }
    result = { type: "tool", name: requiredString(choice.name, "tool_choice.name") };
  }
  if (parallel === false && result.type !== "none") result.disable_parallel_tool_use = true;
  return result;
}

function stopSequences(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return [value];
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value as string[];
  }
  throw new ConversionError("stop 必须是字符串或字符串数组", "invalid_payload", "stop");
}

function assertCompletedStatus(value: unknown, field: string): void {
  if (value !== undefined && value !== "completed") {
    throw new ConversionError(
      `${field}=${String(value)} 无法作为已完成历史项转换`,
      "unsupported_responses_feature",
      field
    );
  }
}

interface AnthropicMessage extends JsonObject {
  role: "user" | "assistant";
  content: JsonObject[];
}

function appendMessage(
  messages: AnthropicMessage[],
  role: "user" | "assistant",
  blocks: JsonObject[],
  kind: "text" | "tool_use" | "tool_result"
): void {
  if (blocks.length === 0) return;
  const previous = messages.at(-1);
  // Anthropic requires tool_result blocks to come before any text in a user
  // message. Start a fresh message if a result follows user text.
  const previousHasNonResult = previous?.role === "user" && previous.content.some(
    (block) => block.type !== "tool_result"
  );
  if (kind === "tool_result" && previous?.role === "user" && previousHasNonResult) {
    throw new ConversionError(
      "function_call_output 不能跟在同一 Anthropic user turn 的文本之后",
      "invalid_tool_result_order"
    );
  }
  if (previous?.role === role) {
    previous.content.push(...blocks);
  } else {
    messages.push({ role, content: [...blocks] });
  }
}

function instructionsToSystem(value: unknown, field: string): JsonObject[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (!Array.isArray(value)) {
    throw new ConversionError(`${field} 仅支持文本 instructions`, "unsupported_content", field);
  }

  const blocks: JsonObject[] = [];
  value.forEach((raw, index) => {
    const item = objectValue(raw, `${field}[${index}]`);
    if (item.type !== undefined && item.type !== "message") {
      throw new ConversionError(
        `${field}[${index}].type 必须是 message`,
        "unsupported_content",
        `${field}[${index}].type`
      );
    }
    if (item.role === "system" || item.role === "developer") {
      blocks.push(...contentToTextBlocks(item.content, `${field}[${index}].content`));
      return;
    }
    throw new ConversionError(
      `${field}[${index}] 无法转换为 Anthropic system`,
      "unsupported_content",
      `${field}[${index}]`
    );
  });
  return blocks;
}

/** Convert one OpenAI Responses request into an Anthropic Messages request. */
export function convertResponsesRequestToAnthropic(
  value: unknown,
  options: Pick<ResponsesConversionOptions, "defaultMaxTokens" | "model"> = {}
): JsonObject {
  const body = objectValue(value, "Responses 请求");
  rejectField(body, "previous_response_id", "previous_response_id 依赖 OpenAI 服务端状态，无法转换");
  rejectField(body, "conversation", "conversation 依赖 OpenAI 服务端会话，无法转换");
  rejectField(body, "prompt", "托管 prompt/template 无法转换");
  rejectField(body, "background", "background Responses 无法转换");
  rejectField(body, "store", "store=true 的服务端存储语义无法转换");
  if (body.store !== false) {
    throw new ConversionError(
      "O→A 路由要求显式设置 store=false；Anthropic 不提供 Responses 服务端存储",
      "unsupported_responses_feature",
      "store"
    );
  }
  if (body.stream !== undefined && typeof body.stream !== "boolean") {
    throw new ConversionError("stream 必须是布尔值", "invalid_payload", "stream");
  }
  if (
    body.parallel_tool_calls !== undefined &&
    typeof body.parallel_tool_calls !== "boolean"
  ) {
    throw new ConversionError(
      "parallel_tool_calls 必须是布尔值",
      "invalid_payload",
      "parallel_tool_calls"
    );
  }
  for (const field of ["temperature", "top_p"] as const) {
    if (
      body[field] !== undefined &&
      (typeof body[field] !== "number" || !Number.isFinite(body[field]))
    ) {
      throw new ConversionError(`${field} 必须是数字`, "invalid_payload", field);
    }
  }
  for (const field of ["user", "safety_identifier"] as const) {
    if (
      body[field] !== undefined &&
      body[field] !== null &&
      (typeof body[field] !== "string" || body[field].length === 0)
    ) {
      throw new ConversionError(`${field} 必须是非空字符串`, "invalid_payload", field);
    }
  }
  const textConfig = optionalObject(body.text);
  if (body.text !== undefined && body.text !== null && !textConfig) {
    throw new ConversionError("text 必须是对象", "invalid_payload", "text");
  }
  const format = optionalObject(textConfig?.format);
  if (textConfig?.format !== undefined && textConfig.format !== null && !format) {
    throw new ConversionError("text.format 必须是对象", "invalid_payload", "text.format");
  }
  if (format && format.type !== "text") {
    throw new ConversionError("结构化 text.format 无法转换", "unsupported_responses_feature", "text.format");
  }

  const model = options.model ?? requiredString(body.model, "model");
  const maxTokensRaw = body.max_output_tokens ?? options.defaultMaxTokens ?? 4096;
  if (!Number.isInteger(maxTokensRaw) || (maxTokensRaw as number) <= 0) {
    throw new ConversionError("max_output_tokens 必须是正整数", "invalid_payload", "max_output_tokens");
  }

  const messages: AnthropicMessage[] = [];
  const system: JsonObject[] = instructionsToSystem(body.instructions, "instructions");
  const seenCalls = new Set<string>();
  const seenResults = new Set<string>();
  let sawConversationItem = false;
  const input = body.input;
  const items: unknown[] = typeof input === "string"
    ? [{ type: "message", role: "user", content: input }]
    : Array.isArray(input)
      ? input
      : (() => {
          throw new ConversionError("input 必须是字符串或输入项数组", "invalid_payload", "input");
        })();

  items.forEach((raw, index) => {
    if (typeof raw === "string") {
      sawConversationItem = true;
      appendMessage(messages, "user", [{ type: "text", text: raw }], "text");
      return;
    }
    const item = objectValue(raw, `input[${index}]`);
    const type = item.type ?? (item.role ? "message" : undefined);
    if (type === "message") {
      const role = requiredString(item.role, `input[${index}].role`);
      assertCompletedStatus(item.status, `input[${index}].status`);
      const blocks = contentToTextBlocks(item.content, `input[${index}].content`);
      if (role === "system" || role === "developer") {
        if (sawConversationItem) {
          throw new ConversionError(
            `input[${index}] 的 ${role} 消息不能在会话消息之后无损提升到 system`,
            "unsupported_content",
            `input[${index}].role`
          );
        }
        system.push(...blocks);
      }
      else if (role === "user" || role === "assistant") {
        sawConversationItem = true;
        appendMessage(messages, role, blocks, "text");
      } else {
        throw new ConversionError(
          `input[${index}].role=${role} 无法转换`,
          "unsupported_content",
          `input[${index}].role`
        );
      }
      return;
    }
    if (type === "function_call") {
      const callId = requiredString(item.call_id ?? item.id, `input[${index}].call_id`);
      assertCompletedStatus(item.status, `input[${index}].status`);
      if (seenCalls.has(callId)) {
        throw new ConversionError(
          `input 中存在重复 function_call call_id=${callId}`,
          "invalid_payload",
          `input[${index}].call_id`
        );
      }
      seenCalls.add(callId);
      sawConversationItem = true;
      appendMessage(messages, "assistant", [{
        type: "tool_use",
        id: callId,
        name: requiredString(item.name, `input[${index}].name`),
        input: parseFunctionArguments(item.arguments, `input[${index}].arguments`),
      }], "tool_use");
      return;
    }
    if (type === "function_call_output") {
      const callId = requiredString(item.call_id, `input[${index}].call_id`);
      if (!seenCalls.has(callId)) {
        throw new ConversionError(
          `function_call_output 引用了当前 input 中不存在的 call_id=${callId}`,
          "orphan_function_call_output",
          `input[${index}].call_id`
        );
      }
      if (
        item.status !== undefined &&
        item.status !== "completed" &&
        item.status !== "failed"
      ) {
        throw new ConversionError(
          `input[${index}].status=${String(item.status)} 无 Anthropic 工具结果等价语义`,
          "unsupported_responses_feature",
          `input[${index}].status`
        );
      }
      if (seenResults.has(callId)) {
        throw new ConversionError(
          `input 中存在重复 function_call_output call_id=${callId}`,
          "invalid_payload",
          `input[${index}].call_id`
        );
      }
      seenResults.add(callId);
      sawConversationItem = true;
      const block: JsonObject = {
        type: "tool_result",
        tool_use_id: callId,
        content: toolResultContent(item.output, `input[${index}].output`),
      };
      if (item.status === "failed") block.is_error = true;
      appendMessage(messages, "user", [block], "tool_result");
      return;
    }
    throw new ConversionError(
      `Responses 输入项 ${String(type ?? "未知")} 无法转换`,
      "unsupported_input_item",
      `input[${index}]`
    );
  });

  if (messages.length === 0) {
    throw new ConversionError("input 中没有可发送给 Anthropic 的消息", "invalid_payload", "input");
  }

  const result: JsonObject = {
    model,
    max_tokens: maxTokensRaw,
    messages,
  };
  if (system.length) result.system = system;
  const tools = mapResponsesTools(body.tools);
  if (tools !== undefined) result.tools = tools;
  let choice: JsonObject | undefined;
  if (tools && tools.length > 0) {
    choice = mapToolChoice(body.tool_choice, body.parallel_tool_calls);
    if (choice?.type === "tool") {
      const name = choice.name;
      if (!tools.some((tool) => tool.name === name)) {
        throw new ConversionError(
          `tool_choice 引用了未定义函数 ${String(name)}`,
          "invalid_payload",
          "tool_choice.name"
        );
      }
    }
  } else if (
    body.tool_choice !== undefined &&
    body.tool_choice !== null &&
    body.tool_choice !== "none" &&
    body.tool_choice !== "auto"
  ) {
    throw new ConversionError(
      "未定义 tools 时不能强制选择工具",
      "invalid_payload",
      "tool_choice"
    );
  }
  if (choice !== undefined) result.tool_choice = choice;
  if (typeof body.stream === "boolean") result.stream = body.stream;
  if (typeof body.temperature === "number") result.temperature = body.temperature;
  if (typeof body.top_p === "number") result.top_p = body.top_p;
  const stops = stopSequences(body.stop);
  if (stops !== undefined) result.stop_sequences = stops;
  const userId = typeof body.safety_identifier === "string" && body.safety_identifier
    ? body.safety_identifier
    : typeof body.user === "string" && body.user
      ? body.user
      : null;
  if (userId) result.metadata = { user_id: userId };
  return result;
}

function validateStopReason(value: unknown, field: string): void {
  if (
    value === undefined || value === null || value === "end_turn" ||
    value === "stop_sequence" || value === "tool_use" || value === "max_tokens"
  ) return;
  throw new ConversionError(
    `Anthropic stop_reason=${String(value)} 无 Responses 等价语义`,
    "unsupported_anthropic_stop_reason",
    field
  );
}

function responseId(messageId: string, explicit?: string): string {
  if (explicit) return explicit;
  if (messageId.startsWith("resp_")) return messageId;
  if (messageId.startsWith("msg_")) return `resp_${messageId.slice(4)}`;
  return `resp_${messageId}`;
}

function usageInteger(
  value: unknown,
  field: string,
  { nullable = false }: { nullable?: boolean } = {}
): number {
  if (value === null && nullable) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ConversionError(`${field} 必须是非负整数`, "invalid_usage", field);
  }
  return value as number;
}

function streamIndex(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ConversionError(`${field} 必须是非负整数`, "invalid_sse", field);
  }
  return value as number;
}

function responseUsage(value: unknown): JsonObject {
  const usage = objectValue(value, "usage");
  const billingContainer = optionalObject(usage.billing_usage);
  if (
    usage.billing_usage !== undefined &&
    usage.billing_usage !== null &&
    !billingContainer
  ) {
    throw new ConversionError(
      "usage.billing_usage 必须是对象",
      "invalid_usage",
      "usage.billing_usage"
    );
  }
  const billing = optionalObject(billingContainer?.openai_usage);
  if (
    billingContainer?.openai_usage !== undefined &&
    billingContainer.openai_usage !== null &&
    !billing
  ) {
    throw new ConversionError(
      "usage.billing_usage.openai_usage 必须是对象",
      "invalid_usage",
      "usage.billing_usage.openai_usage"
    );
  }
  if (billing) {
    if (
      billing.prompt_tokens !== undefined &&
      billing.input_tokens !== undefined &&
      billing.prompt_tokens !== billing.input_tokens
    ) {
      throw new ConversionError(
        "OpenAI billing prompt_tokens 与 input_tokens 不一致",
        "invalid_usage",
        "usage.billing_usage.openai_usage.input_tokens"
      );
    }
    if (
      billing.completion_tokens !== undefined &&
      billing.output_tokens !== undefined &&
      billing.completion_tokens !== billing.output_tokens
    ) {
      throw new ConversionError(
        "OpenAI billing completion_tokens 与 output_tokens 不一致",
        "invalid_usage",
        "usage.billing_usage.openai_usage.output_tokens"
      );
    }
    const input = usageInteger(
      billing.prompt_tokens ?? billing.input_tokens,
      "usage.billing_usage.openai_usage.prompt_tokens"
    );
    const output = usageInteger(
      billing.completion_tokens ?? billing.output_tokens,
      "usage.billing_usage.openai_usage.completion_tokens"
    );
    const details = optionalObject(billing.prompt_tokens_details ?? billing.input_tokens_details);
    if (
      (billing.prompt_tokens_details !== undefined || billing.input_tokens_details !== undefined) &&
      !details
    ) {
      throw new ConversionError(
        "OpenAI billing prompt_tokens_details 必须是对象",
        "invalid_usage",
        "usage.billing_usage.openai_usage.prompt_tokens_details"
      );
    }
    const cached = details?.cached_tokens === undefined
      ? 0
      : usageInteger(
          details.cached_tokens,
          "usage.billing_usage.openai_usage.prompt_tokens_details.cached_tokens"
        );
    const cacheWrite = details?.cache_write_tokens === undefined
      ? 0
      : usageInteger(
          details.cache_write_tokens,
          "usage.billing_usage.openai_usage.prompt_tokens_details.cache_write_tokens"
        );
    if (cached + cacheWrite > input) {
      throw new ConversionError(
        "OpenAI billing 缓存 token 超过 input_tokens",
        "invalid_usage",
        "usage.billing_usage.openai_usage.prompt_tokens_details"
      );
    }
    const outputDetails = optionalObject(
      billing.completion_tokens_details ?? billing.output_tokens_details
    );
    if (
      (billing.completion_tokens_details !== undefined ||
        billing.output_tokens_details !== undefined) &&
      !outputDetails
    ) {
      throw new ConversionError(
        "OpenAI billing completion_tokens_details 必须是对象",
        "invalid_usage",
        "usage.billing_usage.openai_usage.completion_tokens_details"
      );
    }
    const reasoning = outputDetails?.reasoning_tokens === undefined
      ? 0
      : usageInteger(
          outputDetails.reasoning_tokens,
          "usage.billing_usage.openai_usage.completion_tokens_details.reasoning_tokens"
        );
    if (reasoning > output) {
      throw new ConversionError(
        "OpenAI billing reasoning_tokens 超过 output_tokens",
        "invalid_usage",
        "usage.billing_usage.openai_usage.completion_tokens_details.reasoning_tokens"
      );
    }
    const total = billing.total_tokens === undefined
      ? input + output
      : usageInteger(
          billing.total_tokens,
          "usage.billing_usage.openai_usage.total_tokens"
        );
    if (total !== input + output) {
      throw new ConversionError(
        "OpenAI billing total_tokens 与 input/output 不一致",
        "invalid_usage",
        "usage.billing_usage.openai_usage.total_tokens"
      );
    }
    const inputDetails: JsonObject = { cached_tokens: cached };
    if (details?.cache_write_tokens !== undefined) {
      inputDetails.cache_write_tokens = cacheWrite;
    }
    return {
      input_tokens: input,
      input_tokens_details: inputDetails,
      output_tokens: output,
      output_tokens_details: { reasoning_tokens: reasoning },
      total_tokens: total,
    };
  }
  const baseInput = usageInteger(usage.input_tokens, "usage.input_tokens");
  const cacheCreation = usage.cache_creation_input_tokens === undefined
    ? 0
    : usageInteger(
        usage.cache_creation_input_tokens,
        "usage.cache_creation_input_tokens",
        { nullable: true }
      );
  const cacheRead = usage.cache_read_input_tokens === undefined
    ? 0
    : usageInteger(
        usage.cache_read_input_tokens,
        "usage.cache_read_input_tokens",
        { nullable: true }
      );
  const input = baseInput + cacheCreation + cacheRead;
  const output = usageInteger(usage.output_tokens, "usage.output_tokens");
  const cacheCreationDetails = optionalObject(usage.cache_creation);
  if (usage.cache_creation !== undefined && usage.cache_creation !== null && !cacheCreationDetails) {
    throw new ConversionError(
      "usage.cache_creation 必须是对象",
      "invalid_usage",
      "usage.cache_creation"
    );
  }
  let cacheCreationBreakdown = 0;
  if (cacheCreationDetails) {
    for (const key of ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"] as const) {
      if (cacheCreationDetails[key] !== undefined) {
        cacheCreationBreakdown += usageInteger(
          cacheCreationDetails[key],
          `usage.cache_creation.${key}`
        );
      }
    }
    if (
      usage.cache_creation_input_tokens !== undefined &&
      usage.cache_creation_input_tokens !== null &&
      cacheCreationBreakdown !== cacheCreation
    ) {
      throw new ConversionError(
        "usage.cache_creation 明细与 cache_creation_input_tokens 不一致",
        "invalid_usage",
        "usage.cache_creation"
      );
    }
  }
  const outputDetails = optionalObject(usage.output_tokens_details);
  if (
    usage.output_tokens_details !== undefined &&
    usage.output_tokens_details !== null &&
    !outputDetails
  ) {
    throw new ConversionError(
      "usage.output_tokens_details 必须是对象",
      "invalid_usage",
      "usage.output_tokens_details"
    );
  }
  const reasoningTokens = outputDetails?.thinking_tokens === undefined
    ? 0
    : usageInteger(
        outputDetails.thinking_tokens,
        "usage.output_tokens_details.thinking_tokens"
      );
  if (reasoningTokens > output) {
    throw new ConversionError(
      "usage.output_tokens_details.thinking_tokens 超过 output_tokens",
      "invalid_usage",
      "usage.output_tokens_details.thinking_tokens"
    );
  }
  const inputDetails: JsonObject = { cached_tokens: cacheRead };
  if (usage.cache_creation_input_tokens !== undefined) {
    inputDetails.cache_write_tokens = cacheCreation;
  }
  return {
    input_tokens: input,
    input_tokens_details: inputDetails,
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: reasoningTokens },
    total_tokens: input + output,
  };
}

function incompleteReason(stopReason: unknown): JsonObject | null {
  if (stopReason === "max_tokens") return { reason: "max_output_tokens" };
  return null;
}

function baseResponse(
  id: string,
  model: string,
  status: "in_progress" | "completed" | "incomplete" | "failed",
  output: JsonObject[],
  usage: JsonObject | null,
  options: ResponsesConversionOptions,
  incompleteDetails: JsonObject | null = null,
  error: JsonObject | null = null
): JsonObject {
  const request = options.request ?? {};
  return {
    id,
    object: "response",
    created_at: options.createdAt ?? Math.floor(Date.now() / 1000),
    status,
    error,
    incomplete_details: incompleteDetails,
    instructions: request.instructions ?? null,
    max_output_tokens: request.max_output_tokens ?? null,
    model,
    output,
    parallel_tool_calls: request.parallel_tool_calls ?? true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: request.temperature ?? null,
    text: request.text ?? { format: { type: "text" } },
    tool_choice: request.tool_choice ?? "auto",
    tools: request.tools ?? [],
    top_p: request.top_p ?? null,
    truncation: "disabled",
    usage,
    metadata: request.metadata ?? {},
  };
}

function textItem(id: string, texts: string[], status: "completed" | "incomplete"): JsonObject {
  return {
    id,
    type: "message",
    status,
    role: "assistant",
    content: texts.map((text) => ({
      type: "output_text",
      annotations: [],
      logprobs: [],
      text,
    })),
  };
}

/** Convert a non-streaming Anthropic Message into an OpenAI Responses object. */
export function convertAnthropicResponseToResponses(
  value: unknown,
  options: ResponsesConversionOptions = {}
): JsonObject {
  const message = objectValue(value, "Anthropic 响应");
  if (message.type !== "message") {
    throw new ConversionError("Anthropic response.type 必须是 message", "invalid_payload", "type");
  }
  if (message.role !== "assistant") {
    throw new ConversionError("Anthropic response.role 必须是 assistant", "invalid_payload", "role");
  }
  const messageId = requiredString(message.id, "id");
  const model = message.model === undefined
    ? options.model ?? "unknown"
    : requiredString(message.model, "model");
  if (!Array.isArray(message.content)) {
    throw new ConversionError("Anthropic content 必须是数组", "invalid_payload", "content");
  }
  validateStopReason(message.stop_reason, "stop_reason");
  if (message.stop_reason === undefined || message.stop_reason === null) {
    throw new ConversionError(
      "Anthropic 非流式响应缺少终止原因",
      "invalid_payload",
      "stop_reason"
    );
  }
  const incomplete = message.stop_reason === "max_tokens";
  const itemStatus = incomplete ? "incomplete" : "completed";
  const output: JsonObject[] = [];
  let pendingTexts: string[] = [];
  let textGroup = 0;
  const flushText = () => {
    if (!pendingTexts.length) return;
    const currentGroup = textGroup++;
    const id = currentGroup === 0 ? messageId : `${messageId}_${currentGroup}`;
    output.push(textItem(id, pendingTexts, itemStatus));
    pendingTexts = [];
  };

  message.content.forEach((raw, index) => {
    const block = objectValue(raw, `content[${index}]`);
    if (block.type === "text" && typeof block.text === "string") {
      pendingTexts.push(block.text);
      return;
    }
    // OpenAI Responses has no lossless equivalent for Anthropic's private
    // chain-of-thought blocks.  They are deliberately omitted from the client
    // response while the surrounding visible text, tools and usage continue
    // to be converted normally.
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      return;
    }
    flushText();
    if (block.type === "tool_use") {
      if (!optionalObject(block.input)) {
        throw new ConversionError(
          `content[${index}].input 必须是对象`,
          "invalid_payload",
          `content[${index}].input`
        );
      }
      const toolId = requiredString(block.id, `content[${index}].id`);
      output.push({
        id: toolId,
        type: "function_call",
        status: itemStatus,
        call_id: toolId,
        name: requiredString(block.name, `content[${index}].name`),
        arguments: JSON.stringify(block.input ?? {}),
      });
      return;
    }
    throw new ConversionError(
      `Anthropic content ${String(block.type ?? "未知")} 无 Responses 等价项`,
      "unsupported_anthropic_content",
      `content[${index}]`
    );
  });
  flushText();

  const status = incomplete ? "incomplete" : "completed";
  return baseResponse(
    responseId(messageId, options.responseId),
    model,
    status,
    output,
    responseUsage(message.usage),
    options,
    incompleteReason(message.stop_reason)
  );
}

type StreamItem = {
  kind: "text" | "tool" | "thinking";
  anthropicIndex: number;
  outputIndex: number;
  itemId: string;
  name?: string;
  text: string;
  initialInput?: unknown;
};

/**
 * Incremental Anthropic SSE -> OpenAI Responses SSE converter.
 *
 * feed() accepts strings or arbitrary Uint8Array chunks (including one byte at
 * a time) and returns zero or more complete Responses SSE frames. finish()
 * flushes TextDecoder state and a final SSE event that lacks a trailing blank
 * line.
 */
export class AnthropicToResponsesSseConverter {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly options: ResponsesConversionOptions;
  private buffer = "";
  /** Frames produced in a feed/finish call that later threw before returning. */
  private pendingFrames = "";
  private sequence = 0;
  private messageId = "msg_pending";
  private currentResponseId: string;
  private model: string;
  private created = false;
  private stopped = false;
  private failed = false;
  private output: JsonObject[] = [];
  private blocks = new Map<number, StreamItem>();
  private readonly seenBlockIndexes = new Set<number>();
  private readonly seenItemIds = new Set<string>();
  private inputBase = 0;
  private cacheCreation = 0;
  private cacheRead = 0;
  private outputTokens = 0;
  private reasoningTokens = 0;
  private retainedContent = 0;
  private stopReason: unknown = null;

  constructor(options: ResponsesConversionOptions = {}) {
    this.options = {
      ...options,
      createdAt: options.createdAt ?? Math.floor(Date.now() / 1000),
    };
    this.currentResponseId = options.responseId ?? "resp_pending";
    this.model = options.model ?? "unknown";
  }

  feed(chunk: string | Uint8Array): string {
    if (this.stopped && (typeof chunk === "string" ? chunk.length : chunk.byteLength)) {
      throw new ConversionError("message_stop 之后收到额外 Anthropic SSE 数据", "invalid_sse");
    }
    try {
      this.buffer += typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    } catch (error) {
      throw new ConversionError(
        `Anthropic SSE 包含非法 UTF-8：${error instanceof Error ? error.message : String(error)}`,
        "invalid_utf8"
      );
    }
    return this.drain(false);
  }

  /** Alias convenient for TransformStream-style callers. */
  push(chunk: string | Uint8Array): string {
    return this.feed(chunk);
  }

  finish(): string {
    try {
      this.buffer += this.decoder.decode();
    } catch (error) {
      throw new ConversionError(
        `Anthropic SSE 包含非法 UTF-8：${error instanceof Error ? error.message : String(error)}`,
        "invalid_utf8"
      );
    }
    const output = this.drain(true);
    if (!this.stopped) {
      // finish() cannot return `output` once it throws. Preserve those already
      // generated frames so failureFrame() can deliver them before terminating.
      this.pendingFrames += output;
      throw new ConversionError(
        "Anthropic SSE 在 message_stop 前结束",
        "truncated_sse"
      );
    }
    return output;
  }

  /** Alias convenient for stream flush callbacks. */
  flush(): string {
    return this.finish();
  }

  didFail(): boolean {
    return this.failed;
  }

  /**
   * Terminate a partially converted stream after a local routing/conversion
   * failure.  Unlike a stateless fallback frame, this preserves the response
   * id already exposed by response.created and advances the same sequence.
   * A Responses stream may have only one terminal event, so failures observed
   * after response.completed/response.failed intentionally emit nothing.
   */
  failureFrame(
    message: string,
    code = "route_conversion_error"
  ): string {
    const pending = this.pendingFrames;
    this.pendingFrames = "";
    this.buffer = "";
    if (this.stopped) return pending;
    return pending + this.failResponse(code, message);
  }

  private drain(final: boolean): string {
    let out = "";
    try {
      const separator = /\r?\n\r?\n/g;
      let consumed = 0;
      let match: RegExpExecArray | null;
      while ((match = separator.exec(this.buffer)) !== null) {
        const eventLength = match.index - consumed;
        if (eventLength > MAX_SSE_BUFFER) {
          throw new ConversionError("SSE 事件超过 1 MiB 限制", "sse_too_large");
        }
        const raw = this.buffer.slice(consumed, match.index);
        consumed = match.index + match[0].length;
        separator.lastIndex = consumed;
        out += this.handleSseEvent(raw);
      }
      if (consumed > 0) this.buffer = this.buffer.slice(consumed);
      if (final && this.buffer.trim()) {
        if (this.buffer.length > MAX_SSE_BUFFER) {
          throw new ConversionError("SSE 事件超过 1 MiB 限制", "sse_too_large");
        }
        out += this.handleSseEvent(this.buffer);
        this.buffer = "";
      }
      if (this.buffer.length > MAX_SSE_BUFFER) {
        throw new ConversionError("SSE 事件超过 1 MiB 限制", "sse_too_large");
      }
      return out;
    } catch (error) {
      // The caller never receives a function's return value when a later event
      // in the same chunk throws. Keep the valid prefix for failureFrame().
      this.pendingFrames += out;
      throw error;
    }
  }

  private emit(type: string, fields: JsonObject): string {
    const event = { type, sequence_number: this.sequence++, ...fields };
    return `event: ${type}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private handleSseEvent(raw: string): string {
    const lines = raw.split(/\r?\n/);
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    if (!dataLines.length) return "";
    const dataRaw = dataLines.join("\n");
    let payload: JsonObject;
    try {
      payload = objectValue(JSON.parse(dataRaw), "Anthropic SSE data");
    } catch (error) {
      if (error instanceof ConversionError) throw error;
      throw new ConversionError("Anthropic SSE data 不是合法 JSON", "invalid_sse");
    }
    const payloadType = typeof payload.type === "string" ? payload.type : "";
    if (!payloadType) {
      throw new ConversionError("Anthropic SSE payload 缺少 type", "invalid_sse", "type");
    }
    if (eventName && eventName !== payloadType) {
      throw new ConversionError(
        `Anthropic SSE event=${eventName} 与 payload.type=${payloadType} 不一致`,
        "invalid_sse",
        "type"
      );
    }
    const type = eventName || payloadType;
    return this.handlePayload(type, payload);
  }

  private handlePayload(type: string, payload: JsonObject): string {
    if (this.stopped) {
      throw new ConversionError(
        `${type || "未知事件"} 出现在终止事件之后`,
        "invalid_sse"
      );
    }
    if (type === "ping") {
      return "";
    }
    if (type === "message_start") return this.startMessage(payload);
    if (!this.created && type !== "error") {
      throw new ConversionError(`${type || "未知事件"} 出现在 message_start 之前`, "invalid_sse");
    }
    if (type === "content_block_start") return this.startBlock(payload);
    if (type === "content_block_delta") return this.deltaBlock(payload);
    if (type === "content_block_stop") return this.stopBlock(payload);
    if (type === "message_delta") return this.deltaMessage(payload);
    if (type === "message_stop") return this.stopMessage(payload);
    if (type === "error") return this.failMessage(payload);
    throw new ConversionError(`不支持的 Anthropic SSE 事件 ${type || "未知"}`, "unsupported_anthropic_event");
  }

  private startMessage(payload: JsonObject): string {
    if (this.created) throw new ConversionError("重复的 message_start", "invalid_sse");
    const message = objectValue(payload.message, "message_start.message");
    if (message.type !== "message" || message.role !== "assistant") {
      throw new ConversionError(
        "message_start 必须包含 Anthropic assistant message",
        "invalid_sse"
      );
    }
    if (!Array.isArray(message.content) || message.content.length !== 0) {
      throw new ConversionError(
        "message_start.message.content 必须是空数组",
        "invalid_sse"
      );
    }
    this.messageId = requiredString(message.id, "message_start.message.id");
    this.currentResponseId = responseId(this.messageId, this.options.responseId);
    this.model = requiredString(message.model, "message_start.message.model");
    this.mergeUsage(objectValue(message.usage, "message_start.message.usage"));
    this.created = true;
    const created = baseResponse(
      this.currentResponseId,
      this.model,
      "in_progress",
      [],
      null,
      this.options
    );
    return this.emit("response.created", { response: created }) +
      this.emit("response.in_progress", { response: created });
  }

  private startBlock(payload: JsonObject): string {
    const index = streamIndex(payload.index, "content_block_start.index");
    if (this.seenBlockIndexes.has(index)) {
      throw new ConversionError(`重复的 content block ${index}`, "invalid_sse");
    }
    this.seenBlockIndexes.add(index);
    const block = objectValue(payload.content_block, "content_block_start.content_block");
    const outputIndex = this.output.length;
    if (outputIndex >= MAX_STREAM_ITEMS) {
      throw new ConversionError("流式输出项超过 256 个", "stream_too_large");
    }
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new ConversionError(
          "content_block_start.content_block.text 必须是字符串",
          "invalid_sse",
          "content_block_start.content_block.text"
        );
      }
      const itemId = outputIndex === 0 ? this.messageId : `${this.messageId}_${index}`;
      if (this.seenItemIds.has(itemId)) {
        throw new ConversionError(`重复的输出 item id=${itemId}`, "invalid_sse");
      }
      this.seenItemIds.add(itemId);
      const state: StreamItem = {
        kind: "text", anthropicIndex: index, outputIndex, itemId,
        text: block.text,
      };
      if (state.text.length > MAX_STREAM_CONTENT) {
        throw new ConversionError("流式文本超过 4 MiB 限制", "stream_too_large");
      }
      this.reserveContent(state.text.length, "流式累计内容");
      this.blocks.set(index, state);
      const item: JsonObject = {
        id: itemId, type: "message", status: "in_progress", role: "assistant", content: [],
      };
      this.output.push(item);
      let out = this.emit("response.output_item.added", { output_index: outputIndex, item });
      out += this.emit("response.content_part.added", {
        item_id: itemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: "output_text", annotations: [], logprobs: [], text: "" },
      });
      if (state.text) out += this.textDelta(state, state.text);
      return out;
    }
    if (block.type === "tool_use") {
      const itemId = requiredString(block.id, "content_block_start.content_block.id");
      if (this.seenItemIds.has(itemId)) {
        throw new ConversionError(`重复的输出 item id=${itemId}`, "invalid_sse");
      }
      this.seenItemIds.add(itemId);
      const initialInput = objectValue(
        block.input,
        "content_block_start.content_block.input"
      );
      if (Object.keys(initialInput).length !== 0) {
        throw new ConversionError(
          "流式 tool_use 起始 input 必须为空对象；参数应通过 input_json_delta 发送",
          "invalid_sse",
          "content_block_start.content_block.input"
        );
      }
      const initialArguments = JSON.stringify(initialInput);
      if (initialArguments.length > MAX_STREAM_CONTENT) {
        throw new ConversionError("工具参数超过 4 MiB 限制", "stream_too_large");
      }
      this.reserveContent(initialArguments.length, "流式累计内容");
      const state: StreamItem = {
        kind: "tool", anthropicIndex: index, outputIndex, itemId,
        name: requiredString(block.name, "content_block_start.content_block.name"),
        text: "",
        initialInput,
      };
      this.blocks.set(index, state);
      const item = {
        id: itemId,
        type: "function_call",
        status: "in_progress",
        call_id: itemId,
        name: state.name,
        arguments: "",
      };
      this.output.push(item);
      return this.emit("response.output_item.added", { output_index: outputIndex, item });
    }
    if (block.type === "thinking" || block.type === "redacted_thinking") {
      // Keep an explicit state entry even though no Responses output item is
      // emitted.  Anthropic still sends start/delta/stop events for thinking,
      // so retaining the block is necessary to enforce the normal lifecycle.
      this.blocks.set(index, {
        kind: "thinking",
        anthropicIndex: index,
        outputIndex: -1,
        itemId: "",
        text: "",
      });
      return "";
    }
    throw new ConversionError(
      `Anthropic content ${String(block.type ?? "未知")} 无 Responses 流式等价项`,
      "unsupported_anthropic_content"
    );
  }

  private deltaBlock(payload: JsonObject): string {
    const index = streamIndex(payload.index, "content_block_delta.index");
    const state = this.blocks.get(index);
    if (!state) throw new ConversionError(`找不到 content block ${index}`, "invalid_sse");
    const delta = objectValue(payload.delta, "content_block_delta.delta");
    if (
      state.kind === "thinking" &&
      (delta.type === "thinking_delta" || delta.type === "signature_delta")
    ) {
      // Reasoning and its signature are intentionally private in this route.
      // Consume their lifecycle frames without retaining or exposing them.
      return "";
    }
    if (state.kind === "text" && delta.type === "text_delta" && typeof delta.text === "string") {
      if (state.text.length + delta.text.length > MAX_STREAM_CONTENT) {
        throw new ConversionError("流式文本超过 4 MiB 限制", "stream_too_large");
      }
      this.reserveContent(delta.text.length, "流式累计内容");
      state.text += delta.text;
      return this.textDelta(state, delta.text);
    }
    if (state.kind === "tool" && delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
      if (state.text.length + delta.partial_json.length > MAX_STREAM_CONTENT) {
        throw new ConversionError("工具参数超过 4 MiB 限制", "stream_too_large");
      }
      this.reserveContent(delta.partial_json.length, "流式累计内容");
      state.text += delta.partial_json;
      return this.emit("response.function_call_arguments.delta", {
        item_id: state.itemId,
        output_index: state.outputIndex,
        delta: delta.partial_json,
      });
    }
    throw new ConversionError(
      `Anthropic delta ${String(delta.type ?? "未知")} 与当前 block 不兼容`,
      "unsupported_anthropic_content"
    );
  }

  private textDelta(state: StreamItem, delta: string): string {
    return this.emit("response.output_text.delta", {
      item_id: state.itemId,
      output_index: state.outputIndex,
      content_index: 0,
      delta,
      logprobs: [],
    });
  }

  private stopBlock(payload: JsonObject): string {
    const index = streamIndex(payload.index, "content_block_stop.index");
    const state = this.blocks.get(index);
    if (!state) throw new ConversionError(`找不到 content block ${index}`, "invalid_sse");
    this.blocks.delete(index);
    if (state.kind === "thinking") return "";
    if (state.kind === "text") {
      const part = { type: "output_text", annotations: [], logprobs: [], text: state.text };
      const item = textItem(state.itemId, [state.text], "completed");
      this.output[state.outputIndex] = item;
      return this.emit("response.output_text.done", {
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: 0,
        text: state.text,
        logprobs: [],
      }) + this.emit("response.content_part.done", {
        item_id: state.itemId,
        output_index: state.outputIndex,
        content_index: 0,
        part,
      }) + this.emit("response.output_item.done", {
        output_index: state.outputIndex,
        item,
      });
    }

    const args = state.text || JSON.stringify(state.initialInput ?? {});
    // Validate the completed argument string. Responses clients expect a JSON
    // object and should never receive a silently corrupted partial_json stream.
    parseFunctionArguments(args, "function_call.arguments");
    const item = {
      id: state.itemId,
      type: "function_call",
      status: "completed",
      call_id: state.itemId,
      name: state.name,
      arguments: args,
    };
    this.output[state.outputIndex] = item;
    return this.emit("response.function_call_arguments.done", {
      item_id: state.itemId,
      output_index: state.outputIndex,
      arguments: args,
    }) + this.emit("response.output_item.done", {
      output_index: state.outputIndex,
      item,
    });
  }

  private deltaMessage(payload: JsonObject): string {
    if (this.blocks.size !== 0) {
      throw new ConversionError(
        "message_delta 出现在 content block 结束之前",
        "invalid_sse"
      );
    }
    const delta = objectValue(payload.delta, "message_delta.delta");
    validateStopReason(delta.stop_reason, "message_delta.delta.stop_reason");
    if (delta.stop_reason === undefined || delta.stop_reason === null) {
      throw new ConversionError("message_delta 缺少 stop_reason", "invalid_sse");
    }
    if (this.stopReason !== null && this.stopReason !== delta.stop_reason) {
      throw new ConversionError("流中出现冲突的 stop_reason", "invalid_sse");
    }
    this.stopReason = delta.stop_reason;
    this.mergeUsage(objectValue(payload.usage, "message_delta.usage"));
    return "";
  }

  private stopMessage(payload: JsonObject): string {
    if (this.blocks.size) {
      throw new ConversionError("message_stop 时仍有未结束的 content block", "invalid_sse");
    }
    if (this.stopReason === null) {
      throw new ConversionError("message_stop 前缺少 stop_reason", "invalid_sse");
    }
    this.stopped = true;
    const incomplete = this.stopReason === "max_tokens";
    const status = incomplete ? "incomplete" : "completed";
    const response = baseResponse(
      this.currentResponseId,
      this.model,
      status,
      this.output,
      this.currentUsage(),
      this.options,
      incompleteReason(this.stopReason)
    );
    return this.emit(incomplete ? "response.incomplete" : "response.completed", { response });
  }

  private failMessage(payload: JsonObject): string {
    const upstream = objectValue(payload.error, "error.error");
    return this.failResponse(
      requiredString(upstream.type, "error.error.type"),
      requiredString(upstream.message, "error.error.message")
    );
  }

  private failResponse(code: string, message: string): string {
    this.stopped = true;
    this.failed = true;
    const response = baseResponse(
      this.currentResponseId,
      this.model,
      "failed",
      this.output,
      this.created ? this.currentUsage() : null,
      this.options,
      null,
      { code, message }
    );
    return this.emit("response.failed", { response });
  }

  private mergeUsage(value: unknown): void {
    const usage = optionalObject(value);
    if (!usage) {
      throw new ConversionError("stream.usage 必须是对象", "invalid_usage", "stream.usage");
    }
    if (usage.billing_usage !== undefined && usage.billing_usage !== null) {
      const converted = responseUsage(usage);
      const input = usageInteger(converted.input_tokens, "stream.usage.input_tokens");
      const output = usageInteger(converted.output_tokens, "stream.usage.output_tokens");
      const inputDetails = objectValue(
        converted.input_tokens_details,
        "stream.usage.input_tokens_details"
      );
      const outputDetails = objectValue(
        converted.output_tokens_details,
        "stream.usage.output_tokens_details"
      );
      const cached = usageInteger(
        inputDetails.cached_tokens,
        "stream.usage.input_tokens_details.cached_tokens"
      );
      const cacheWrite = inputDetails.cache_write_tokens === undefined
        ? 0
        : usageInteger(
            inputDetails.cache_write_tokens,
            "stream.usage.input_tokens_details.cache_write_tokens"
          );
      this.inputBase = Math.max(this.inputBase, input - cached - cacheWrite);
      this.cacheCreation = Math.max(this.cacheCreation, cacheWrite);
      this.cacheRead = Math.max(this.cacheRead, cached);
      this.outputTokens = Math.max(this.outputTokens, output);
      this.reasoningTokens = Math.max(
        this.reasoningTokens,
        usageInteger(
          outputDetails.reasoning_tokens,
          "stream.usage.output_tokens_details.reasoning_tokens"
        )
      );
      return;
    }
    if (usage.input_tokens !== undefined && usage.input_tokens !== null) {
      this.inputBase = Math.max(
        this.inputBase,
        usageInteger(usage.input_tokens, "stream.usage.input_tokens")
      );
    }
    if (
      usage.cache_creation_input_tokens !== undefined &&
      usage.cache_creation_input_tokens !== null
    ) {
      this.cacheCreation = Math.max(
        this.cacheCreation,
        usageInteger(
          usage.cache_creation_input_tokens,
          "stream.usage.cache_creation_input_tokens"
        )
      );
    }
    if (
      usage.cache_read_input_tokens !== undefined &&
      usage.cache_read_input_tokens !== null
    ) {
      this.cacheRead = Math.max(
        this.cacheRead,
        usageInteger(
          usage.cache_read_input_tokens,
          "stream.usage.cache_read_input_tokens"
        )
      );
    }
    if (usage.output_tokens !== undefined && usage.output_tokens !== null) {
      this.outputTokens = Math.max(
        this.outputTokens,
        usageInteger(usage.output_tokens, "stream.usage.output_tokens")
      );
    }
    const cacheCreationDetails = optionalObject(usage.cache_creation);
    if (
      usage.cache_creation !== undefined &&
      usage.cache_creation !== null &&
      !cacheCreationDetails
    ) {
      throw new ConversionError(
        "stream.usage.cache_creation 必须是对象",
        "invalid_usage",
        "stream.usage.cache_creation"
      );
    }
    if (cacheCreationDetails) {
      let breakdown = 0;
      for (const key of ["ephemeral_1h_input_tokens", "ephemeral_5m_input_tokens"] as const) {
        if (cacheCreationDetails[key] !== undefined) {
          breakdown += usageInteger(
            cacheCreationDetails[key],
            `stream.usage.cache_creation.${key}`
          );
        }
      }
      if (
        usage.cache_creation_input_tokens !== undefined &&
        usage.cache_creation_input_tokens !== null &&
        breakdown !== usage.cache_creation_input_tokens
      ) {
        throw new ConversionError(
          "stream.usage.cache_creation 明细与总数不一致",
          "invalid_usage",
          "stream.usage.cache_creation"
        );
      }
    }
    const outputDetails = optionalObject(usage.output_tokens_details);
    if (
      usage.output_tokens_details !== undefined &&
      usage.output_tokens_details !== null &&
      !outputDetails
    ) {
      throw new ConversionError(
        "stream.usage.output_tokens_details 必须是对象",
        "invalid_usage",
        "stream.usage.output_tokens_details"
      );
    }
    if (outputDetails) {
      if (outputDetails.thinking_tokens !== undefined) {
        const thinking = usageInteger(
          outputDetails.thinking_tokens,
          "stream.usage.output_tokens_details.thinking_tokens"
        );
        const eventOutput = usage.output_tokens === undefined || usage.output_tokens === null
          ? this.outputTokens
          : usage.output_tokens as number;
        if (thinking > eventOutput) {
          throw new ConversionError(
            "stream thinking_tokens 超过 output_tokens",
            "invalid_usage",
            "stream.usage.output_tokens_details.thinking_tokens"
          );
        }
        this.reasoningTokens = Math.max(this.reasoningTokens, thinking);
      }
    }
  }

  private currentUsage(): JsonObject {
    return responseUsage({
      input_tokens: this.inputBase,
      cache_creation_input_tokens: this.cacheCreation,
      cache_read_input_tokens: this.cacheRead,
      output_tokens: this.outputTokens,
      output_tokens_details: { thinking_tokens: this.reasoningTokens },
    });
  }

  private reserveContent(length: number, label: string): void {
    if (this.retainedContent + length > MAX_STREAM_TOTAL_CONTENT) {
      throw new ConversionError(
        `${label}超过 16 MiB 限制`,
        "stream_too_large"
      );
    }
    this.retainedContent += length;
  }
}

/** A byte TransformStream for directly piping an upstream fetch body. */
export function createAnthropicToResponsesSseTransform(
  options: ResponsesConversionOptions = {}
): TransformStream<Uint8Array, Uint8Array> {
  const converter = new AnthropicToResponsesSseConverter(options);
  const encoder = new TextEncoder();
  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      const output = converter.feed(chunk);
      if (output) controller.enqueue(encoder.encode(output));
    },
    flush(controller) {
      const output = converter.finish();
      if (output) controller.enqueue(encoder.encode(output));
    },
  });
}

// Explicit aliases make the direction obvious at integration call sites.
export const convertOpenAiResponsesRequestToAnthropic = convertResponsesRequestToAnthropic;
export const convertAnthropicToOpenAiResponses = convertAnthropicResponseToResponses;
export const createAnthropicToOpenAiResponsesSseTransform = createAnthropicToResponsesSseTransform;

/** String wrappers for relay paths that already buffer JSON as text. */
export function responsesReqToAnt(text: string, model?: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConversionError("Responses 请求体不是合法 JSON", "invalid_json");
  }
  return JSON.stringify(convertResponsesRequestToAnthropic(parsed, { model }));
}

export function antRespToResponses(
  text: string,
  options: ResponsesConversionOptions = {}
): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConversionError("Anthropic 响应体不是合法 JSON", "invalid_json");
  }
  return JSON.stringify(convertAnthropicResponseToResponses(parsed, options));
}

export class AntStreamToResponses extends AnthropicToResponsesSseConverter {}
