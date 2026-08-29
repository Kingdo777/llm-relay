// 全局类型定义

/**
 * LLM 协议类型。
 *
 * - openai：OpenAI Chat Completions（/v1/chat/completions），Bearer 鉴权
 * - openai-responses：OpenAI Responses（/v1/responses），Bearer 鉴权
 * - anthropic：Anthropic Messages（/v1/messages），x-api-key 鉴权
 *
 * 默认同格式透传；每个 LLM 可通过 route_mode 开启跨协议转换路由。
 */
export type Protocol = "openai" | "anthropic" | "openai-responses";
export type BaseUrlMode = "unified" | "separate";
export type RouteMode =
  | "off"
  | "anthropic-to-openai"
  | "openai-to-anthropic";

export type ParsedLogBlock =
  | { type: "text"; text: string; format: "markdown" | "plain" }
  | { type: "tool"; name: string; input?: unknown; output?: unknown }
  | { type: "data"; label: string; value: unknown };

export interface ParsedLogEntry {
  role: string;
  blocks: ParsedLogBlock[];
}

export interface ParsedLogContent {
  entries: ParsedLogEntry[];
  metadata?: Record<string, unknown>;
  warnings?: string[];
}

/**
 * LLM 配置（数据库行结构）。
 *
 * - alias：别名，作为对外的"模型名"，客户端把 model 填成这个值来选中该 LLM
 * - url_mode：unified 表示三个协议共用地址；separate 表示 OpenAI 与 Anthropic 分开
 * - OpenAI Chat Completions / Responses 共用 openai_base_url
 *
 * 中转入口固定为 http://host/，请求路径末段决定协议：
 *   .../v1/chat/completions → OpenAI（Chat Completions）
 *   .../v1/responses        → OpenAI（Responses）
 *   .../v1/messages          → Anthropic
 */
export interface LlmRow {
  id: number;
  /** 显示名（仅用于展示） */
  name: string;
  /** 别名 = 对外的 model 名，全局唯一；客户端把 model 填成它来选中本 LLM */
  alias: string;
  url_mode: BaseUrlMode;
  /** 协议转换路由；off 表示按请求协议直接透传。 */
  route_mode: RouteMode;
  /** 兼容旧调用；合一模式下等于统一 URL，分离模式下等于 OpenAI URL */
  base_url: string;
  openai_base_url: string;
  anthropic_base_url: string;
  openai_supported: 0 | 1 | null;
  anthropic_supported: 0 | 1 | null;
  openai_responses_supported: 0 | 1 | null;
  protocols_tested_at: string | null;
  token: string;
  /** 非空时使用 CodeAgent 的 x-auth-token + app-id 鉴权。 */
  app_id: string;
  model_name: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** 创建/更新 LLM 时前端传入的载荷 */
export interface LlmInput {
  name: string;
  alias: string;
  url_mode: BaseUrlMode;
  /** 省略时创建默认关闭，更新时保留现值。 */
  route_mode?: RouteMode;
  /** 合一模式使用；保留该字段也便于旧客户端继续调用 API */
  base_url?: string;
  openai_base_url?: string;
  anthropic_base_url?: string;
  token: string;
  /** CodeAgent 专用 app-id；省略表示使用普通协议鉴权。 */
  app_id?: string;
  model_name: string;
  enabled?: boolean;
}

/** 日志行（数据库结构） */
export interface LogRow {
  id: number;
  llm_id: number | null;
  llm_alias: string;
  /** 本次请求走的协议（由请求路径末段决定） */
  protocol: Protocol;
  /** 后端实际使用的 base url */
  base_url: string;
  /** 后端实际请求路径，如 v1/chat/completions */
  endpoint: string;
  model_name: string | null;
  input: string | null;
  output: string | null;
  status: "success" | "failed" | "streaming";
  error: string | null;
  duration_ms: number;
  status_code: number | null;
  is_stream: 0 | 1 | null;
  /** 上游返回的 token 用量；老日志或上游未返回 usage 时为 null */
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  /** 命中上游 Prompt Cache 的输入 Token；null 表示上游未返回。 */
  cached_input_tokens: number | null;
  /** 从收到 relay 请求到收到上游首个响应字节的时间 */
  first_byte_ms: number | null;
  created_at: string;
  parsed_input: string | null;
  parsed_output: string | null;
  parsed_at: string | null;
  parser_version: number | null;
}

/** 测试连接结果 */
export interface TestResult {
  success: boolean;
  message: string;
  /** 实际响应内容或错误详情 */
  detail?: string;
  duration_ms?: number;
}

export interface ProtocolSupportResult {
  openai: TestResult;
  openaiResponses: TestResult;
  anthropic: TestResult;
  tested_at: string;
}

export interface ModelStats24h {
  llm_id: number;
  name: string;
  alias: string;
  model_name: string;
  requests: number;
  successful_requests: number;
  failed_requests: number;
  success_rate: number;
  current_rpm: number;
  current_tpm: number;
  average_rpm: number;
  average_tpm: number;
  peak_rpm: number;
  peak_tpm: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  token_coverage: number;
  average_duration_ms: number | null;
  p95_duration_ms: number | null;
  average_first_byte_ms: number | null;
  output_tokens_per_second: number | null;
}

export interface StatsSeriesPoint {
  bucket: string;
  requests: number;
  successful_requests: number;
  failed_requests: number;
  tokens: number;
}

export interface ModelStatsSeries {
  llm_id: number;
  points: StatsSeriesPoint[];
}

export interface DailyTokenPoint {
  date: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
}

export interface ModelDailyTokens {
  llm_id: number;
  points: DailyTokenPoint[];
}

export interface DashboardStats {
  window_started_at: string;
  generated_at: string;
  series_bucket_minutes: number;
  summary: Omit<ModelStats24h, "llm_id" | "name" | "alias" | "model_name">;
  models: ModelStats24h[];
  series: StatsSeriesPoint[];
  model_series: ModelStatsSeries[];
  daily_tokens: DailyTokenPoint[];
  model_daily_tokens: ModelDailyTokens[];
}

/** 统一 API 响应包装（用于 CRUD 等接口，中转接口除外） */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
