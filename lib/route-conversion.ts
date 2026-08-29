import type { LlmRow, Protocol } from "./types";
import type { RoutePlan } from "./route-plan";
import {
  AnthropicToOpenAIStreamConverter,
  OpenAIToAnthropicStreamConverter,
  convertAnthropicRequestToOpenAIChat,
  convertAnthropicResponseToOpenAIChat,
  convertOpenAIChatRequestToAnthropic,
  convertOpenAIChatResponseToAnthropic,
} from "./protocol-convert";
import {
  AnthropicToResponsesSseConverter,
  convertAnthropicResponseToResponses,
  convertResponsesRequestToAnthropic,
} from "./responses-convert";

type JsonObject = Record<string, unknown>;

export interface RoutedConversionContext {
  /** 已改写真实 model_name 的客户端请求对象。 */
  clientRequest: JsonObject;
}

export interface RoutedStreamConverter {
  feed(chunk: string | Uint8Array): string;
  finish(): string;
  didFail?(): boolean;
  failureFrame?(message: string): string;
}

function parseObject(text: string, label: string): JsonObject {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`${label}不是合法 JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}必须是 JSON 对象`);
  }
  return value as JsonObject;
}

/** 将客户端请求转换成 route plan 指定的上游协议。 */
export function convertRoutedRequest(
  body: string,
  plan: RoutePlan,
  llm: Pick<LlmRow, "model_name">
): { body: string; context: RoutedConversionContext } {
  if (!plan.routed) {
    throw new Error("非路由请求不应调用协议转换器");
  }
  const clientRequest = parseObject(body, "客户端请求体");
  let converted: JsonObject;
  if (plan.clientProtocol === "anthropic" && plan.backendProtocol === "openai") {
    converted = convertAnthropicRequestToOpenAIChat(clientRequest);
  } else if (
    plan.clientProtocol === "openai" &&
    plan.backendProtocol === "anthropic"
  ) {
    converted = convertOpenAIChatRequestToAnthropic(clientRequest);
  } else if (
    plan.clientProtocol === "openai-responses" &&
    plan.backendProtocol === "anthropic"
  ) {
    converted = convertResponsesRequestToAnthropic(clientRequest, {
      model: llm.model_name,
    });
  } else {
    throw new Error(
      `不支持的协议路由：${plan.clientProtocol}→${plan.backendProtocol}`
    );
  }
  return { body: JSON.stringify(converted), context: { clientRequest } };
}

/** 将上游非流式成功响应转换回客户端协议。 */
export function convertRoutedResponse(
  body: string,
  plan: RoutePlan,
  llm: Pick<LlmRow, "model_name">,
  context: RoutedConversionContext
): string {
  if (!plan.routed) return body;
  const upstream = parseObject(body, "上游响应体");
  if (plan.backendProtocol === "openai" && plan.clientProtocol === "anthropic") {
    return JSON.stringify(
      convertOpenAIChatResponseToAnthropic(upstream, llm.model_name)
    );
  }
  if (plan.backendProtocol === "anthropic" && plan.clientProtocol === "openai") {
    return JSON.stringify(
      convertAnthropicResponseToOpenAIChat(upstream, llm.model_name)
    );
  }
  if (
    plan.backendProtocol === "anthropic" &&
    plan.clientProtocol === "openai-responses"
  ) {
    return JSON.stringify(
      convertAnthropicResponseToResponses(upstream, {
        model: llm.model_name,
        request: context.clientRequest,
      })
    );
  }
  throw new Error(
    `不支持的响应路由：${plan.backendProtocol}→${plan.clientProtocol}`
  );
}

/** 为上游 SSE 创建返回客户端协议的增量转换器。 */
export function createRoutedStreamConverter(
  plan: RoutePlan,
  llm: Pick<LlmRow, "model_name">,
  context: RoutedConversionContext
): RoutedStreamConverter {
  if (plan.backendProtocol === "openai" && plan.clientProtocol === "anthropic") {
    return new OpenAIToAnthropicStreamConverter();
  }
  if (plan.backendProtocol === "anthropic" && plan.clientProtocol === "openai") {
    return new AnthropicToOpenAIStreamConverter();
  }
  if (
    plan.backendProtocol === "anthropic" &&
    plan.clientProtocol === "openai-responses"
  ) {
    return new AnthropicToResponsesSseConverter({
      model: llm.model_name,
      request: context.clientRequest,
    });
  }
  throw new Error(
    `不支持的流式路由：${plan.backendProtocol}→${plan.clientProtocol}`
  );
}

/** 路由失败时按客户端协议包装错误，避免泄漏目标协议的错误外形。 */
export function convertRoutedError(
  body: string,
  clientProtocol: Protocol,
  status: number,
  errorType: "upstream_error" | "invalid_request_error" = "upstream_error"
): string {
  let parsed: JsonObject | null = null;
  try {
    const value = JSON.parse(body) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      parsed = value as JsonObject;
    }
  } catch {
    // 非 JSON 错误使用原始文本作为 message。
  }
  const nested =
    parsed?.error && typeof parsed.error === "object" && !Array.isArray(parsed.error)
      ? (parsed.error as JsonObject)
      : null;
  const message =
    (typeof nested?.message === "string" && nested.message) ||
    (typeof parsed?.message === "string" && parsed.message) ||
    body.trim() ||
    `上游 HTTP ${status}`;

  if (clientProtocol === "anthropic") {
    return JSON.stringify({
      type: "error",
      error: {
        type: errorType === "invalid_request_error" ? errorType : "api_error",
        message,
      },
    });
  }
  return JSON.stringify({
    error: {
      message,
      type: errorType,
      param: null,
      code: String(status),
    },
  });
}

export function routeDescription(plan: RoutePlan): string {
  return `${plan.clientProtocol}→${plan.backendProtocol}`;
}

/** 将转换器自身错误编码为客户端能识别的 SSE 错误事件。 */
export function routedStreamErrorFrame(
  message: string,
  clientProtocol: Protocol,
  converter?: RoutedStreamConverter
): string {
  if (converter?.failureFrame) {
    return converter.failureFrame(message);
  }
  if (clientProtocol === "anthropic") {
    return `event: error\ndata: ${JSON.stringify({
      type: "error",
      error: { type: "api_error", message },
    })}\n\n`;
  }
  if (clientProtocol === "openai-responses") {
    throw new Error("Responses 路由流错误必须由有状态转换器收尾");
  }
  return `data: ${JSON.stringify({
    error: { message, type: "route_conversion_error", param: null, code: null },
  })}\n\ndata: [DONE]\n\n`;
}
