import type { LlmRow, Protocol } from "./types";
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  rewriteModel,
  UPSTREAM_PATH,
  inferProtocolFromPath,
  extractModel,
  baseUrlForProtocol,
  requestStreamUsage,
} from "./format";
import { insertLog, updateLog } from "./db";
import { compactLogInput } from "./log-parser";
import { extractTokenUsage } from "./usage";

export interface RelayResult {
  response: Response;
  logId: number | null;
}

/** 输出文本入库的最大长度，超出截断，避免单条日志过大 */
const MAX_OUTPUT_LEN = 200_000;
/** 输入文本入库的最大长度 */
const MAX_INPUT_LEN = 200_000;

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[已截断，原始长度 ${s.length}]`;
}

/**
 * 选后端协议与 baseURL。
 * 规则：
 *   - 请求路径决定协议
 *   - OpenAI Chat / Responses 走 OpenAI Base URL
 *   - Anthropic Messages 走 Anthropic Base URL
 *   - 不执行协议转换
 */
export function pickBackend(
  llm: LlmRow,
  clientProtocol: Protocol
): { backendProtocol: Protocol; baseUrl: string } | null {
  const baseUrl = baseUrlForProtocol(llm, clientProtocol);
  if (!baseUrl) return null;
  return {
    backendProtocol: clientProtocol,
    baseUrl,
  };
}

/**
 * 执行中转。
 *
 * @param llm            命中的 LLM
 * @param clientProtocol 客户端请求的协议（由请求路径决定）
 * @param backendProtocol 后端协议（始终与客户端协议一致）
 * @param baseUrl        选用的后端 baseURL
 * @param method         HTTP 方法
 * @param originalHeaders 原始请求头
 * @param rawBody        原始请求体（客户端格式）
 */
export async function relayRequest(
  llm: LlmRow,
  clientProtocol: Protocol,
  backendProtocol: Protocol,
  baseUrl: string,
  method: string,
  originalHeaders: Headers,
  rawBody: string
): Promise<RelayResult> {
  const start = Date.now();

  const subPath = UPSTREAM_PATH[backendProtocol];
  const upstreamUrl = buildUpstreamUrl(baseUrl, subPath);
  // 后端头始终按 backendProtocol 注入鉴权（同格式透传时等于 clientProtocol）
  const headers = buildUpstreamHeaders(
    backendProtocol,
    llm.token,
    originalHeaders,
    llm.app_id
  );

  const rewritten = rewriteModel(rawBody, llm.model_name);
  const rewrittenBody = rewritten.ok ? rewritten.body : rawBody;
  const outBody = requestStreamUsage(rewrittenBody, backendProtocol);

  // 先写一条 streaming 状态的日志占位（无论成败都留痕）
  // protocol 字段记录客户端协议（用户看到的是"我用什么协议请求的"）
  const logId = insertLog({
    llm_id: llm.id,
    llm_alias: llm.alias,
    protocol: clientProtocol,
    base_url: baseUrl,
    endpoint: subPath,
    model_name: llm.model_name,
    input: compactLogInput(rawBody, MAX_INPUT_LEN),
    output: null,
    status: "streaming",
    error: null,
    duration_ms: 0,
    status_code: null,
  });

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : outBody,
    });
  } catch (e) {
    const err = e as Error;
    const cause = (err as { cause?: { code?: string; name?: string } }).cause;
    const duration_ms = Date.now() - start;
    const message =
      cause?.name === "ConnectTimeoutError" ||
      cause?.code === "UND_ERR_CONNECT_TIMEOUT"
        ? "上游连接超时，baseURL 不可达"
        : cause?.code === "ECONNREFUSED"
        ? "上游连接被拒绝（ECONNREFUSED）"
        : cause?.code === "ENOTFOUND"
        ? "上游域名无法解析"
        : `上游连接失败：${err.message}`;
    updateLog(logId, {
      status: "failed",
      error: `${err.name}: ${err.message}${cause ? `\ncause: ${JSON.stringify(cause)}` : ""}`,
      duration_ms,
    });
    return {
      response: new Response(
        JSON.stringify({ error: { message, type: "relay_error" } }),
        {
          status: 502,
          headers: { "content-type": "application/json" },
        }
      ),
      logId,
    };
  }

  const status = response.status;
  const responseStartedMs = Date.now() - start;
  const contentType = response.headers.get("content-type") || "";
  const isSSE = contentType.includes("text/event-stream");

  // 透传响应头（排除 hop-by-hop 和会变化的长相关联头）
  const respHeaders = new Headers();
  response.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (
      lk === "content-encoding" ||
      lk === "content-length" ||
      lk === "transfer-encoding" ||
      lk === "connection"
    )
      return;
    respHeaders.set(k, v);
  });
  if (isSSE && response.body) {
    // ---- 流式：同协议透传并累积日志 ----
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let finalized = false;
    let streamError = "";
    let firstByteMs: number | null = null;

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      const duration_ms = Date.now() - start;
      const ok = status >= 200 && status < 300;
      const usage = extractTokenUsage(accumulated);
      const measurements = {
        first_byte_ms: firstByteMs ?? responseStartedMs,
        ...(usage
          ? {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.totalTokens,
              ...(usage.cachedInputTokens !== null
                ? { cached_input_tokens: usage.cachedInputTokens }
                : {}),
            }
          : {}),
      };
      if (streamError) {
        updateLog(logId, {
          status: "failed",
          error: `流式传输中断：${streamError}`,
          output: clamp(accumulated, MAX_OUTPUT_LEN),
          duration_ms,
          status_code: status,
          is_stream: isSSE ? 1 : 0,
          ...measurements,
        });
      } else {
        updateLog(logId, {
          status: ok ? "success" : "failed",
          error: ok ? null : `上游 HTTP ${status}`,
          output: clamp(accumulated, MAX_OUTPUT_LEN),
          duration_ms,
          status_code: status,
          is_stream: isSSE ? 1 : 0,
          ...measurements,
        });
      }
    };

    const stream = new ReadableStream({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            controller.close();
            finalize();
            return;
          }
          if (firstByteMs === null && value.byteLength > 0) {
            firstByteMs = Date.now() - start;
          }
          const text = decoder.decode(value, { stream: true });
          accumulated += text;
          controller.enqueue(value);
        } catch (e) {
          streamError = (e as Error).message;
          controller.error(e);
          finalize();
        }
      },
      async cancel() {
        await reader.cancel();
        finalize();
      },
    });

    return {
      response: new Response(stream, {
        status,
        headers: respHeaders,
      }),
      logId,
    };
  }

  // ---- 非流式：buffer + 透传 ----
  let bufText = "";
  try {
    const buf = await response.arrayBuffer();
    bufText = new TextDecoder().decode(buf);
  } catch (e) {
    const err = e as Error;
    updateLog(logId, {
      status: "failed",
      error: `读取上游响应失败：${err.message}`,
      duration_ms: Date.now() - start,
      status_code: status,
      is_stream: isSSE ? 1 : 0,
      first_byte_ms: responseStartedMs,
    });
    return {
      response: new Response(
        JSON.stringify({ error: { message: "读取上游响应失败" } }),
        { status: 502, headers: { "content-type": "application/json" } }
      ),
      logId,
    };
  }

  const duration_ms = Date.now() - start;
  const ok = status >= 200 && status < 300;
  const usage = extractTokenUsage(bufText);
  updateLog(logId, {
    status: ok ? "success" : "failed",
    error: ok ? null : `上游 HTTP ${status}\n${bufText.slice(0, 2000)}`,
    output: clamp(bufText, MAX_OUTPUT_LEN),
    duration_ms,
    status_code: status,
    is_stream: isSSE ? 1 : 0,
    first_byte_ms: responseStartedMs,
    ...(usage
      ? {
          input_tokens: usage.inputTokens,
          output_tokens: usage.outputTokens,
          total_tokens: usage.totalTokens,
          ...(usage.cachedInputTokens !== null
            ? { cached_input_tokens: usage.cachedInputTokens }
            : {}),
        }
      : {}),
  });

  return {
    response: new Response(bufText, {
      status,
      headers: respHeaders,
    }),
    logId,
  };
}

/** 解析请求路径，返回客户端协议 */
export function parseProtocolFromRequest(
  path: string
): { protocol: Protocol } | { error: string } {
  const protocol = inferProtocolFromPath(path);
  if (!protocol) {
    return {
      error:
        "无法识别请求路径。OpenAI 请访问 /v1/chat/completions 或 /v1/responses，Anthropic 请访问 /v1/messages。",
    };
  }
  return { protocol };
}

/** 从请求体取出 model（= 别名） */
export function parseAliasFromRequest(
  rawBody: string
): { alias: string } | { error: string } {
  const model = extractModel(rawBody);
  if (!model) {
    return {
      error:
        "请求体缺少 model 字段。请把 model 填成目标 LLM 的别名（即在管理页配置的别名）。",
    };
  }
  return { alias: model };
}
