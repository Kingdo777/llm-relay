import type { Protocol } from "./types";

/** 各协议对应的后端 API 子路径。 */
export const UPSTREAM_PATH: Record<Protocol, string> = {
  openai: "v1/chat/completions",
  "openai-responses": "v1/responses",
  anthropic: "v1/messages",
};

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

/** 构造发往后端的完整 URL */
export function buildUpstreamUrl(baseUrl: string, subPath: string): string {
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
 *   - openai / openai-responses → Authorization: Bearer
 *   - anthropic                 → x-api-key + anthropic-version
 */
export function buildUpstreamHeaders(
  protocol: Protocol,
  token: string,
  originalHeaders: Headers
): Headers {
  const headers = new Headers();
  const skip = new Set([
    "host",
    "connection",
    "content-length",
    "authorization",
    "x-api-key",
    "anthropic-version",
    "accept-encoding", // 让上游不要 gzip，便于我们直接读取
  ]);
  originalHeaders.forEach((value, key) => {
    if (!skip.has(key.toLowerCase())) headers.set(key, value);
  });

  if (protocol === "anthropic") {
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
