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
	const start = Date.now();
	const upstreamUrl = buildUpstreamUrl(llm.base_url, UPSTREAM_PATH[protocol]);
  const headers = buildUpstreamHeaders(
    protocol,
    llm.token,
    new Headers({ "content-type": "application/json" })
  );
  // 除连通性与鉴权外，同时验证 Agent 所需的工具 Schema。只发 hi
  // 会让部分 OpenAI 上游的伪 Anthropic 入口被误判为兼容。
  const body: Record<string, unknown> = {
    model: llm.model_name,
    max_tokens: 32,
    messages: [{ role: "user", content: "Reply OK. Do not call the probe tool." }],
  };
  body.tools = protocol === "anthropic"
    ? [{
        name: "relay_protocol_probe",
        description: "Validate Anthropic tool schema compatibility.",
        input_schema: { type: "object", properties: {}, additionalProperties: false },
      }]
    : [{
        type: "function",
        function: {
          name: "relay_protocol_probe",
          description: "Validate OpenAI tool schema compatibility.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      }];

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
