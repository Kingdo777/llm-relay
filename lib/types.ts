// 全局类型定义

/** LLM 协议类型 */
export type Protocol = "openai" | "anthropic";

/**
 * LLM 配置（数据库行结构）。
 *
 * - alias：别名，作为对外的"模型名"，客户端把 model 填成这个值来选中该 LLM
 * - openai_base_url：OpenAI 协议时使用的后端 base url（可只填一个）
 * - anthropic_base_url：Anthropic 协议时使用的后端 base url（可只填一个）
 *
 * 中转入口固定为 http://host/，请求路径末段决定协议：
 *   .../v1/chat/completions → OpenAI（用 openai_base_url）
 *   .../v1/messages          → Anthropic（用 anthropic_base_url）
 */
export interface LlmRow {
  id: number;
  /** 显示名（仅用于展示） */
  name: string;
  /** 别名 = 对外的 model 名，全局唯一；客户端把 model 填成它来选中本 LLM */
  alias: string;
  /** OpenAI 协议后端 base url；为空表示不支持 OpenAI 入口 */
  openai_base_url: string | null;
  /** Anthropic 协议后端 base url；为空表示不支持 Anthropic 入口 */
  anthropic_base_url: string | null;
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
  openai_base_url?: string | null;
  anthropic_base_url?: string | null;
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
}

/** 测试连接结果 */
export interface TestResult {
  success: boolean;
  message: string;
  /** 实际响应内容或错误详情 */
  detail?: string;
  duration_ms?: number;
}

/** 统一 API 响应包装（用于 CRUD 等接口，中转接口除外） */
export interface ApiResponse<T> {
  ok: boolean;
  data?: T;
  error?: string;
}
