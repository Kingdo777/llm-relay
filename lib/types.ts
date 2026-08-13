// 全局类型定义

/** LLM 协议类型 */
export type Protocol = "openai" | "anthropic";

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
 * - base_url：统一的后端根地址；relay 根据请求路径拼接对应协议端点
 *
 * 中转入口固定为 http://host/，请求路径末段决定协议：
 *   .../v1/chat/completions → OpenAI
 *   .../v1/messages          → Anthropic
 */
export interface LlmRow {
  id: number;
  /** 显示名（仅用于展示） */
  name: string;
  /** 别名 = 对外的 model 名，全局唯一；客户端把 model 填成它来选中本 LLM */
  alias: string;
  base_url: string;
  openai_supported: 0 | 1 | null;
  anthropic_supported: 0 | 1 | null;
  protocols_tested_at: string | null;
  token: string;
  model_name: string;
  enabled: 0 | 1;
  created_at: string;
  updated_at: string;
}

/** 创建/更新 LLM 时前端传入的载荷 */
export interface LlmInput {
  name: string;
  alias: string;
  base_url: string;
  token: string;
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
  anthropic: TestResult;
  tested_at: string;
}

/** 统一 API 响应包装（用于 CRUD 等接口，中转接口除外） */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
