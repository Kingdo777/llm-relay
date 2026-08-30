import type { LlmRow, Protocol, TestResult } from "./types";
import {
  buildUpstreamUrl,
  buildUpstreamHeaders,
  upstreamPathForProtocol,
} from "./format";
import { resolveRoute } from "./route-plan";
import {
  convertRoutedRequest,
  convertRoutedResponse,
  routeDescription,
} from "./route-conversion";
import { fetchUpstreamWithToolTypeFallback } from "./upstream-fetch";

const PROBE_TIMEOUT_MS = 60_000;

/**
 * 测试某个 LLM 配置是否可用：按指定协议发一个最简单的 hi。
 * @param llm      LLM 配置
 * @param protocol 走哪个协议测试
 */
export async function testLlm(
  llm: LlmRow,
  protocol: Protocol
): Promise<TestResult> {
	const start = Date.now();
  const resolved = resolveRoute(llm, protocol);
  if ("error" in resolved) {
    return { success: false, message: resolved.error };
  }
  const plan = resolved.plan;
	const upstreamUrl = buildUpstreamUrl(
    plan.baseUrl,
    upstreamPathForProtocol(
      plan.backendProtocol,
      llm.is_code_agent === 1
    ),
    { codeAgent: llm.is_code_agent === 1 }
  );
  const headers = buildUpstreamHeaders(
    plan.backendProtocol,
    llm.token,
    new Headers({
      "content-type": "application/json",
      accept: "application/json",
    }),
    {
      appId: llm.app_id,
      codeAgent: llm.is_code_agent === 1,
    }
  );
  // 除连通性与鉴权外，同时验证 Agent 所需的工具 Schema。只发 hi
  // 会让部分 OpenAI 上游的伪 Anthropic 入口被误判为兼容。
  const body = buildProbeBody(llm, protocol);
  let outgoingBody = JSON.stringify(body);
  let conversionContext: ReturnType<typeof convertRoutedRequest>["context"] | null = null;
  if (plan.routed) {
    try {
      const converted = convertRoutedRequest(outgoingBody, plan, llm);
      outgoingBody = converted.body;
      conversionContext = converted.context;
    } catch (error) {
      return {
        success: false,
        message: `路由请求转换失败（${routeDescription(plan)}）`,
        detail: (error as Error).message,
      };
    }
  }

  try {
    const fetched = await fetchUpstreamWithToolTypeFallback(upstreamUrl, {
      method: "POST",
      headers,
      body: outgoingBody,
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    }, plan.backendProtocol, outgoingBody);
    const resp = fetched.response;

    const duration_ms = Date.now() - start;
    const upstreamText = await resp.text();

    if (resp.ok) {
      let clientText = upstreamText;
      if (plan.routed) {
        try {
          clientText = convertRoutedResponse(
            upstreamText,
            plan,
            llm,
            conversionContext!
          );
        } catch (error) {
          return {
            success: false,
            message: `路由响应转换失败（${routeDescription(plan)}）`,
            detail: routedResponseFailureDetail(
              error,
              resp.headers.get("content-type"),
              upstreamText
            ),
            duration_ms,
          };
        }
      }
      return {
        success: true,
        message: plan.routed
          ? `路由成功 ${routeDescription(plan)}（HTTP ${resp.status}，${duration_ms}ms）${
              fetched.retriedAnthropicToolType ? "，已兼容工具 type" : ""
            }`
          : `连接成功（HTTP ${resp.status}，${duration_ms}ms）${
              fetched.retriedAnthropicToolType ? "，已兼容工具 type" : ""
            }`,
        detail: tryExtractPreview(clientText),
        duration_ms,
      };
    }
    return {
      success: false,
      message: `上游返回 HTTP ${resp.status}${plan.routed ? `（${routeDescription(plan)}）` : ""}`,
      detail: upstreamText || resp.statusText,
      duration_ms,
    };
  } catch (e) {
    const duration_ms = Date.now() - start;
    const err = e as Error;
    const cause = (err as { cause?: { code?: string; name?: string } }).cause;
    let message = "请求失败";
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      message = `请求超时（${PROBE_TIMEOUT_MS / 1000}s 内未响应）`;
    } else if (
      cause?.name === "ConnectTimeoutError" ||
      cause?.code === "UND_ERR_CONNECT_TIMEOUT"
    ) {
      message = "连接超时，baseURL 不可达或被防火墙拦截";
    } else if (cause?.code === "ECONNREFUSED") {
      message = "连接被拒绝（ECONNREFUSED），请检查 baseURL 与端口是否正确";
    } else if (cause?.code === "ENOTFOUND") {
      message = "域名无法解析，请检查 baseURL";
    } else if (err.message?.includes("fetch failed")) {
      message = "连接失败（网络层错误），请检查 baseURL 是否可达";
    }
    return {
      success: false,
      message,
      detail: `${err.name}: ${err.message}${cause ? `\ncause: ${JSON.stringify(cause)}` : ""}`,
      duration_ms,
    };
  }
}

/** 构造各协议的探测请求体。除连通性与鉴权外，同时带上工具以验证上游对工具 Schema 的兼容。 */
function buildProbeBody(llm: LlmRow, protocol: Protocol): Record<string, unknown> {
  const prompt = "Reply OK. Do not call the probe tool.";
  if (protocol === "anthropic") {
    return {
      model: llm.model_name,
      max_tokens: 32,
      stream: false,
      messages: [{ role: "user", content: prompt }],
      tools: [{
        name: "relay_protocol_probe",
        description: "Validate Anthropic tool schema compatibility.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      }],
    };
  }
  if (protocol === "openai-responses") {
    // Responses 用 input（而非 messages），工具为扁平结构（name/parameters 顶层）。
    return {
      model: llm.model_name,
      max_output_tokens: 32,
      store: false,
      stream: false,
      input: [{ role: "user", content: prompt }],
      tools: [{
        type: "function",
        name: "relay_protocol_probe",
        description: "Validate OpenAI Responses tool schema compatibility.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
    };
  }
  // openai chat completions
  return {
    model: llm.model_name,
    max_tokens: 32,
    stream: false,
    messages: [{ role: "user", content: prompt }],
    tools: [{
      type: "function",
      function: {
        name: "relay_protocol_probe",
        description: "Validate OpenAI tool schema compatibility.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      },
    }],
  };
}

/** 从响应里抽取一段预览文本用于展示 */
function tryExtractPreview(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (parsed.choices?.[0]?.message?.content) {
      return String(parsed.choices[0].message.content).slice(0, 200);
    }
    if (parsed.content?.[0]?.text) {
      return String(parsed.content[0].text).slice(0, 200);
    }
    // OpenAI Responses 非流式响应：output[].content[].text
    if (Array.isArray(parsed.output)) {
      const out = parsed.output
        .flatMap((item: { content?: Array<{ text?: string }> }) =>
          Array.isArray(item?.content) ? item.content.map((c) => c?.text).filter(Boolean) : []
        )
        .join("");
      if (out) return String(out).slice(0, 200);
    }
    if (parsed.error) {
      return JSON.stringify(parsed.error).slice(0, 300);
    }
    return text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}

function routedResponseFailureDetail(
  error: unknown,
  contentType: string | null,
  upstreamText: string
): string {
  const message = error instanceof Error ? error.message : String(error);
  const trimmed = upstreamText.trim();
  const responseKind = !trimmed
    ? "上游响应为空"
    : /^(?:event|data):/m.test(trimmed)
      ? "上游返回了 SSE，而本次请求要求非流式 JSON"
      : "上游响应不是可转换的 JSON";
  const preview = trimmed
    ? `\n响应预览：${trimmed.slice(0, 500)}`
    : "";
  return `${message}\n${responseKind}\nContent-Type: ${contentType || "未提供"}${preview}`;
}
