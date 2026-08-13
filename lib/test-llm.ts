import type { LlmRow, Protocol, TestResult } from "./types";
import { buildUpstreamUrl, buildUpstreamHeaders, UPSTREAM_PATH } from "./format";

/**
 * 测试某个 LLM 配置是否可用：按指定协议发一个最简单的 hi。
 * @param llm      LLM 配置
 * @param protocol 走哪个协议测试
 */
export async function testLlm(
  llm: LlmRow,
  protocol: Protocol
): Promise<TestResult> {
  // 按协议取对应 base url
  const baseUrl =
    protocol === "openai" ? llm.openai_base_url : llm.anthropic_base_url;
  if (!baseUrl) {
    return {
      success: false,
      message: `该 LLM 未配置 ${protocol} 的 baseURL`,
    };
  }

  const start = Date.now();
  const upstreamUrl = buildUpstreamUrl(baseUrl, UPSTREAM_PATH[protocol]);
  const headers = buildUpstreamHeaders(
    protocol,
    llm.token,
    new Headers({ "content-type": "application/json" })
  );
  // 非流式、低 max_tokens，只为验证连通性与鉴权
  const body = {
    model: llm.model_name,
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
  };

  try {
    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    const duration_ms = Date.now() - start;
    const text = await resp.text();

    if (resp.ok) {
      return {
        success: true,
        message: `连接成功（HTTP ${resp.status}，${duration_ms}ms）`,
        detail: tryExtractPreview(text),
        duration_ms,
      };
    }
    return {
      success: false,
      message: `上游返回 HTTP ${resp.status}`,
      detail: text || resp.statusText,
      duration_ms,
    };
  } catch (e) {
    const duration_ms = Date.now() - start;
    const err = e as Error;
    const cause = (err as { cause?: { code?: string; name?: string } }).cause;
    let message = "请求失败";
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      message = "请求超时（30s 内未响应）";
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
    if (parsed.error) {
      return JSON.stringify(parsed.error).slice(0, 300);
    }
    return text.slice(0, 300);
  } catch {
    return text.slice(0, 300);
  }
}
