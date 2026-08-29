import type { LlmRow, Protocol } from "./types";

/** 各协议对应的后端 API 子路径。 */
export const UPSTREAM_PATH: Record<Protocol, string> = {
  openai: "v1/chat/completions",
  "openai-responses": "v1/responses",
  anthropic: "v1/messages",
};

/** 返回实际上游路径；CodeAgent 对外虽由 /v1 接入，上游固定使用 /v2。 */
export function upstreamPathForProtocol(
  protocol: Protocol,
  isCodeAgent = false
): string {
  const path = UPSTREAM_PATH[protocol];
  return isCodeAgent ? path.replace(/^v1\//, "v2/") : path;
}

/** OpenAI Chat / Responses 共用 OpenAI URL，Anthropic 使用独立 URL。 */
export function baseUrlForProtocol(llm: LlmRow, protocol: Protocol): string {
  return protocol === "anthropic"
    ? llm.anthropic_base_url
    : llm.openai_base_url;
}

/**
 * 根据请求路径末段判断协议：
 *   .../v1/chat/completions → openai
 *   .../v1/responses        → openai-responses
 *   .../v1/messages          → anthropic
 * 无法识别返回 null。
 */
export function inferProtocolFromPath(path: string): Protocol | null {
  // 归一化：去前后斜杠
  const p = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (p.endsWith("v1/chat/completions") || p.endsWith("chat/completions")) {
    return "openai";
  }
  if (p.endsWith("v1/responses") || p.endsWith("responses")) {
    return "openai-responses";
  }
  if (p.endsWith("v1/messages") || p.endsWith("messages")) {
    return "anthropic";
  }
  return null;
}

export interface UpstreamUrlOptions {
  /** CodeAgent 的上游 API 固定使用 v2；客户端入口仍保持 v1。 */
  codeAgent?: boolean;
}

/**
 * 将 CodeAgent Base URL 统一到 v2。
 *
 * 脚本或历史配置可能提供根地址、/v1、/v2，甚至旧错误拼接的 /v2/v1；
 * 存储和发送前都归一成单一 /v2，避免再次产生 /v2/v1/...。
 */
export function normalizeCodeAgentBaseUrl(baseUrl: string): string {
  const url = new URL(baseUrl.trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("CodeAgent Base URL 必须使用 http:// 或 https://");
  }
  const path = url.pathname
    .replace(/\/+$/, "")
    .replace(/(?:\/v[12])+$/i, "");
  url.pathname = `${path}/v2`;
  // fragment 不会发送给服务端，避免把无效片段保存为 API Base URL。
  url.hash = "";
  return url.toString();
}

/** 构造发往后端的完整 URL */
export function buildUpstreamUrl(
  baseUrl: string,
  subPath: string,
  options: UpstreamUrlOptions = {}
): string {
  if (options.codeAgent) {
    const base = new URL(normalizeCodeAgentBaseUrl(baseUrl));
    const sub = subPath.replace(/^\/+/, "").replace(/^v[12]\//i, "");
    if (sub) base.pathname = `${base.pathname.replace(/\/+$/, "")}/${sub}`;
    return base.toString();
  }
  const base = baseUrl.replace(/\/+$/, "");
  let sub = subPath.replace(/^\/+/, "");
  if (base.toLowerCase().endsWith("/v1") && sub.toLowerCase().startsWith("v1/")) {
    sub = sub.slice(3);
  }
  if (!sub) return base;
  return `${base}/${sub}`;
}

/**
 * 根据协议构造发往后端的请求头（注入鉴权）。
 * 同格式透传：
 *   - codeAgent=true            → x-auth-token + app-id + x-innercc-request-kind
 *   - openai / openai-responses → Authorization: Bearer
 *   - anthropic                 → x-api-key + anthropic-version
 */
export interface UpstreamAuthOptions {
  appId?: string;
  codeAgent?: boolean;
}

export function buildUpstreamHeaders(
  protocol: Protocol,
  token: string,
  originalHeaders: Headers,
  options: UpstreamAuthOptions = {}
): Headers {
  const headers = new Headers();
  const skip = new Set([
    "host",
    "connection",
    "content-length",
    "authorization",
    "x-api-key",
    "x-auth-token",
    "app-id",
    "x-innercc-request-kind",
    "anthropic-version",
    "accept-encoding", // 让上游不要 gzip，便于我们直接读取
  ]);
  originalHeaders.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) headers.set(key, value);
  });

  const normalizedAppId = options.appId?.trim() ?? "";
  if (options.codeAgent) {
    if (!normalizedAppId) {
      throw new Error("CodeAgent 配置缺少 app_id");
    }
    headers.set("x-auth-token", token);
    headers.set("app-id", normalizedAppId);
    headers.set("x-innercc-request-kind", "main_conversation");
    if (protocol === "anthropic") {
      headers.set("anthropic-version", "2023-06-01");
    }
  } else if (protocol === "anthropic") {
    headers.set("x-api-key", token);
    headers.set("anthropic-version", "2023-06-01");
  } else {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

/**
 * 从请求体里取出 model 字段（客户端填的别名）。
 * 找不到返回 null。
 */
export function extractModel(body: string): string | null {
  if (!body || body.trim() === "") return null;
  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && "model" in parsed) {
      const m = (parsed as Record<string, unknown>).model;
      return typeof m === "string" ? m : null;
    }
  } catch {
    // 非 JSON
  }
  return null;
}

/** 替换请求体里的 model 字段为真实模型名（JSON 解析后重写） */
export function rewriteModel(
  body: string,
  modelName: string
): { ok: true; body: string } | { ok: false; error: string } {
  if (!body || body.trim() === "") return { ok: true, body };
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    // 非 JSON，原样返回
    return { ok: true, body };
  }
  if (parsed && typeof parsed === "object") {
    (parsed as Record<string, unknown>).model = modelName;
    return { ok: true, body: JSON.stringify(parsed) };
  }
  return { ok: true, body };
}

/**
 * 流式 Chat Completions 默认不返回 usage。为保证 TPM 统计完整，向兼容
 * OpenAI 的上游请求 usage 事件；其它协议自身会在流事件中返回 usage。
 */
export function requestStreamUsage(body: string, protocol: Protocol): string {
  if (protocol !== "openai" || !body.trim()) return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.stream !== true) return body;
    const current =
      parsed.stream_options && typeof parsed.stream_options === "object"
        ? (parsed.stream_options as Record<string, unknown>)
        : {};
    parsed.stream_options = { ...current, include_usage: true };
    return JSON.stringify(parsed);
  } catch {
    return body;
  }
}
