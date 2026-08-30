import { normalizeRequestToolTypes } from "./format";
import type { Protocol } from "./types";

const MAX_FALLBACK_ERROR_BYTES = 64 * 1024;

export interface UpstreamFetchResult {
  response: Response;
  retriedAnthropicToolType: boolean;
}

/**
 * 某些 Anthropic 兼容网关非标准地要求 OpenAI 的嵌套 function 工具外形，
 * 而标准 Anthropic/DeepSeek 会拒绝这个结构。先发标准格式，仅在上游明确
 * 报 type 反序列化错误时转换工具结构重试一次，可同时兼容两类实现。
 */
export async function fetchUpstreamWithToolTypeFallback(
  url: string,
  init: RequestInit,
  protocol: Protocol,
  body: string
): Promise<UpstreamFetchResult> {
  const response = await fetch(url, init);
  if (
    protocol !== "anthropic" ||
    response.status !== 400 ||
    !body.includes('"tools"')
  ) {
    return { response, retriedAnthropicToolType: false };
  }

  const contentLength = Number(response.headers.get("content-length") ?? 0);
  if (contentLength > MAX_FALLBACK_ERROR_BYTES) {
    return { response, retriedAnthropicToolType: false };
  }
  let errorText = "";
  try {
    errorText = await response.clone().text();
  } catch {
    return { response, retriedAnthropicToolType: false };
  }
  if (
    errorText.length > MAX_FALLBACK_ERROR_BYTES ||
    !/tools\[\d+\]\.type[\s\S]*expected [`'"]?function/i.test(errorText)
  ) {
    return { response, retriedAnthropicToolType: false };
  }

  const retryBody = normalizeRequestToolTypes(body, "anthropic", {
    anthropicFunctionFallback: true,
  });
  if (retryBody === body) {
    return { response, retriedAnthropicToolType: false };
  }
  try {
    await response.body?.cancel();
  } catch {
    // 原 400 响应可能已被 clone 消费完；取消失败不阻断兼容重试。
  }
  const retried = await fetch(url, { ...init, body: retryBody });
  return { response: retried, retriedAnthropicToolType: true };
}
