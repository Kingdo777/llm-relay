export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

function tokenNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function usageFromObject(value: unknown): TokenUsage | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const baseInput = tokenNumber(record.input_tokens ?? record.prompt_tokens);
  const cacheCreation = tokenNumber(record.cache_creation_input_tokens) ?? 0;
  const cacheRead = tokenNumber(record.cache_read_input_tokens) ?? 0;
  const input =
    baseInput === null && cacheCreation === 0 && cacheRead === 0
      ? null
      : (baseInput ?? 0) + cacheCreation + cacheRead;
  const output = tokenNumber(record.output_tokens ?? record.completion_tokens);
  const total = tokenNumber(record.total_tokens);
  if (input === null && output === null && total === null) return null;

  const inputTokens = input ?? Math.max(0, (total ?? 0) - (output ?? 0));
  const outputTokens = output ?? Math.max(0, (total ?? 0) - inputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
  };
}

function usageCandidates(value: unknown): unknown[] {
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const response =
    record.response && typeof record.response === "object"
      ? (record.response as Record<string, unknown>)
      : null;
  const message =
    record.message && typeof record.message === "object"
      ? (record.message as Record<string, unknown>)
      : null;
  return [record.usage, response?.usage, message?.usage, record];
}

function mergeUsage(current: TokenUsage | null, next: TokenUsage): TokenUsage {
  if (!current) return next;
  // 流式协议通常多次发送累计 usage；逐字段取最大值可合并 Anthropic 的
  // message_start(input) 与 message_delta(output)，也不会重复累计。
  const inputTokens = Math.max(current.inputTokens, next.inputTokens);
  const outputTokens = Math.max(current.outputTokens, next.outputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: Math.max(
      current.totalTokens,
      next.totalTokens,
      inputTokens + outputTokens
    ),
  };
}

function parsePayloads(raw: string): unknown[] {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  try {
    return [JSON.parse(trimmed)];
  } catch {
    // SSE 的 data 可能跨多行；主流 LLM API 的 JSON data 都是单行，逐行解析
    // 能同时覆盖 OpenAI、Responses 与 Anthropic 的流式事件。
    const payloads: unknown[] = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        payloads.push(JSON.parse(data));
      } catch {
        // 单个非 JSON 事件不影响其它 usage 事件。
      }
    }
    return payloads;
  }
}

/** 从 OpenAI / Responses / Anthropic 的 JSON 或 SSE 响应中提取 usage。 */
export function extractTokenUsage(raw: string): TokenUsage | null {
  let usage: TokenUsage | null = null;
  for (const payload of parsePayloads(raw)) {
    for (const candidate of usageCandidates(payload)) {
      const parsed = usageFromObject(candidate);
      if (parsed) usage = mergeUsage(usage, parsed);
    }
  }
  return usage;
}
