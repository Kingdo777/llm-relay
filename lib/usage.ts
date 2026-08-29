export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** null 表示上游未返回缓存明细；0 表示明确没有命中。 */
  cachedInputTokens: number | null;
}

function tokenNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : null;
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function usageFromObject(
  value: unknown,
  inputAlreadyIncludesCache = false
): TokenUsage | null {
  const record = objectRecord(value);
  if (!record) return null;

  // 部分 CodeAgent 桥接响应同时给出 Anthropic 外形和权威的 OpenAI
  // billing_usage；外层 input_tokens 已含 cache_read，不能再次相加。
  const billingUsage = objectRecord(record.billing_usage);
  const openAiBillingUsage = objectRecord(billingUsage?.openai_usage);
  if (openAiBillingUsage) {
    const parsed = usageFromObject(openAiBillingUsage, true);
    if (parsed) return parsed;
  }

  const promptDetails = objectRecord(record.prompt_tokens_details);
  const inputDetails = objectRecord(record.input_tokens_details);
  const cacheCreationRaw = tokenNumber(record.cache_creation_input_tokens);
  const cacheReadRaw = tokenNumber(record.cache_read_input_tokens);
  const cachedCandidates = [
    tokenNumber(promptDetails?.cached_tokens),
    tokenNumber(inputDetails?.cached_tokens),
    cacheReadRaw,
  ].filter((value): value is number => value !== null);
  const cachedInputTokens =
    cachedCandidates.length > 0 ? Math.max(...cachedCandidates) : null;

  const baseInput = tokenNumber(record.prompt_tokens ?? record.input_tokens);
  const output = tokenNumber(
    "prompt_tokens" in record || inputAlreadyIncludesCache
      ? record.completion_tokens ?? record.output_tokens
      : record.output_tokens ?? record.completion_tokens
  );
  const total = tokenNumber(record.total_tokens);
  if (baseInput === null && output === null && total === null) return null;

  const hasInclusiveCacheSemantics =
    inputAlreadyIncludesCache ||
    "prompt_tokens" in record ||
    promptDetails !== null ||
    inputDetails !== null;
  const input = hasInclusiveCacheSemantics
    ? baseInput
    : baseInput === null && cacheCreationRaw === null && cacheReadRaw === null
      ? null
      : (baseInput ?? 0) + (cacheCreationRaw ?? 0) + (cacheReadRaw ?? 0);

  const inputTokens = input ?? Math.max(0, (total ?? 0) - (output ?? 0));
  const outputTokens = output ?? Math.max(0, (total ?? 0) - inputTokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens: total ?? inputTokens + outputTokens,
    cachedInputTokens,
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
  const cachedInputTokens =
    current.cachedInputTokens === null
      ? next.cachedInputTokens
      : next.cachedInputTokens === null
        ? current.cachedInputTokens
        : Math.max(current.cachedInputTokens, next.cachedInputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
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

/**
 * 仅用于历史日志回填：正文被 clamp 截断时通常缺少最终 usage，不能用
 * message_start 的部分值覆盖旧统计；只有未被日志层截断的响应才参与回填。
 */
export function extractRecoverableTokenUsage(raw: string): TokenUsage | null {
  if (/\n…\[已截断，原始长度 \d+\]$/.test(raw)) {
    return null;
  }
  return extractTokenUsage(raw);
}
