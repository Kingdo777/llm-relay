import type { LlmRow, Protocol } from "./types";
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  rewriteModel,
  UPSTREAM_PATH,
  inferProtocolFromPath,
  extractModel,
} from "./format";
import {
  oaiReqToAnt,
  antReqToOai,
  antRespToOai,
  oaiRespToAnt,
  AntStreamToOai,
  OaiStreamToAnt,
} from "./convert";
import { insertLog, updateLog } from "./db";

export interface RelayResult {
  response: Response;
  logId: number | null;
}

/** 默认上游超时（首个字节） */
const UPSTREAM_TIMEOUT_MS = 120_000;
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
 *   - 优先用与 clientProtocol 同协议的 baseURL（同格式，无需转换）
 *   - 该 LLM 没配同协议 baseURL 时，回退到另一种协议的 baseURL，做跨格式转换
 *   - 两种都没配则返回 null
 */
export function pickBackend(
  llm: LlmRow,
  clientProtocol: Protocol
): { backendProtocol: Protocol; baseUrl: string; converted: boolean } | null {
  const same =
    clientProtocol === "openai"
      ? llm.openai_base_url
      : llm.anthropic_base_url;
  if (same) {
    return { backendProtocol: clientProtocol, baseUrl: same, converted: false };
  }
  // 回退到另一种协议
  const other =
    clientProtocol === "openai"
      ? llm.anthropic_base_url
      : llm.openai_base_url;
  if (other) {
    return {
      backendProtocol: clientProtocol === "openai" ? "anthropic" : "openai",
      baseUrl: other,
      converted: true,
    };
  }
  return null;
}

/**
 * 执行中转。
 *
 * @param llm            命中的 LLM
 * @param clientProtocol 客户端请求的协议（由请求路径决定）
 * @param backendProtocol 后端协议（由选中的 baseURL 决定，可能与客户端不同 → 跨格式转换）
 * @param baseUrl        选用的后端 baseURL
 * @param converted      是否发生了跨格式转换
 * @param method         HTTP 方法
 * @param originalHeaders 原始请求头
 * @param rawBody        原始请求体（客户端格式）
 */
export async function relayRequest(
  llm: LlmRow,
  clientProtocol: Protocol,
  backendProtocol: Protocol,
  baseUrl: string,
  converted: boolean,
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
    originalHeaders
  );

  // ---- 构造发往后端的请求体 ----
  let outBody = rawBody;
  // 1) 先把客户端请求体里的 model 覆盖为真实模型名
  //    （rewriteModel 内部会 JSON 解析后改 model 字段）
  // 2) 若跨格式，再做请求体协议转换
  try {
    if (converted) {
      // 跨格式：先覆盖 model，再整体转换格式
      const rewritten = rewriteModel(rawBody, llm.model_name);
      const bodyJson = rewritten.ok ? rewritten.body : rawBody;
      const parsed = JSON.parse(bodyJson);
      const translated =
        clientProtocol === "openai"
          ? oaiReqToAnt(parsed) // 客户端 OpenAI → 后端 Anthropic
          : antReqToOai(parsed); // 客户端 Anthropic → 后端 OpenAI
      outBody = JSON.stringify(translated);
    } else {
      // 同格式：仅覆盖 model
      const rewritten = rewriteModel(rawBody, llm.model_name);
      outBody = rewritten.ok ? rewritten.body : rawBody;
    }
  } catch {
    // 解析失败，原样透传（可能上游能容忍）
  }

  // 先写一条 streaming 状态的日志占位（无论成败都留痕）
  // protocol 字段记录客户端协议（用户看到的是"我用什么协议请求的"）
  const logId = insertLog({
    llm_id: llm.id,
    llm_alias: llm.alias,
    protocol: clientProtocol,
    base_url: baseUrl,
    endpoint: subPath,
    model_name: llm.model_name,
    input: clamp(rawBody, MAX_INPUT_LEN),
    output: null,
    status: "streaming",
    error: converted ? `跨格式转换：${clientProtocol}→${backendProtocol}` : null,
    duration_ms: 0,
    status_code: null,
  });

  let response: Response;
  try {
    response = await fetch(upstreamUrl, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : outBody,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (e) {
    const err = e as Error;
    const cause = (err as { cause?: { code?: string; name?: string } }).cause;
    const duration_ms = Date.now() - start;
    const message =
      err.name === "TimeoutError" || err.name === "AbortError"
        ? "上游超时（120s 无响应）"
        : cause?.name === "ConnectTimeoutError" ||
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
  // 跨格式时响应 content-type 要改成客户端协议对应的类型
  if (converted) {
    respHeaders.set("content-type", "application/json");
  }

  if (isSSE && response.body) {
    // ---- 流式：透传 + 累积 + 按需转换 ----
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let accumulated = "";
    let finalized = false;
    let streamError = "";

    // 跨格式流式转换器
    const streamConverter =
      converted
        ? backendProtocol === "anthropic"
          ? new AntStreamToOai() // 后端 Anthropic 流 → 客户端 OpenAI 流
          : new OaiStreamToAnt() // 后端 OpenAI 流 → 客户端 Anthropic 流
        : null;

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      const duration_ms = Date.now() - start;
      const ok = status >= 200 && status < 300;
      if (streamError) {
        updateLog(logId, {
          status: "failed",
          error: `流式传输中断：${streamError}`,
          output: clamp(accumulated, MAX_OUTPUT_LEN),
          duration_ms,
          status_code: status,
        });
      } else {
        updateLog(logId, {
          status: ok ? "success" : "failed",
          error: ok
            ? converted
              ? `跨格式转换：${clientProtocol}→${backendProtocol}`
              : null
            : `上游 HTTP ${status}`,
          output: clamp(accumulated, MAX_OUTPUT_LEN),
          duration_ms,
          status_code: status,
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
          const text = decoder.decode(value, { stream: true });
          accumulated += text;
          if (streamConverter) {
            // 跨格式：把上游 SSE chunk 转成目标协议 SSE，再发给客户端
            const translated = streamConverter.feed(text);
            if (translated) {
              controller.enqueue(new TextEncoder().encode(translated));
            }
          } else {
            // 同格式：原样透传
            controller.enqueue(value);
          }
        } catch (e) {
          streamError = (e as Error).message;
          controller.error(e);
          finalize();
        }
      },
      cancel() {
        finalize();
      },
    });

    return {
      response: new Response(stream, {
        status,
        headers: streamConverter
          ? // 跨格式时响应是 SSE（由转换器产生）
            new Headers({
              "content-type": "text/event-stream",
              "cache-control": "no-cache",
              connection: "keep-alive",
            })
          : respHeaders,
      }),
      logId,
    };
  }

  // ---- 非流式：buffer + 转换 + 透传 ----
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
    });
    return {
      response: new Response(
        JSON.stringify({ error: { message: "读取上游响应失败" } }),
        { status: 502, headers: { "content-type": "application/json" } }
      ),
      logId,
    };
  }

  // 跨格式转换响应体
  let outText = bufText;
  if (converted) {
    try {
      outText =
        backendProtocol === "anthropic"
          ? antRespToOai(bufText, llm.model_name) // 后端 Anthropic → 客户端 OpenAI
          : oaiRespToAnt(bufText, llm.model_name); // 后端 OpenAI → 客户端 Anthropic
    } catch {
      outText = bufText; // 转换失败原样返回
    }
  }

  const duration_ms = Date.now() - start;
  const ok = status >= 200 && status < 300;
  updateLog(logId, {
    status: ok ? "success" : "failed",
    error: ok
      ? converted
        ? `跨格式转换：${clientProtocol}→${backendProtocol}`
        : null
      : `上游 HTTP ${status}\n${bufText.slice(0, 2000)}`,
    output: clamp(outText, MAX_OUTPUT_LEN),
    duration_ms,
    status_code: status,
  });

  return {
    response: new Response(outText, {
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
        "无法识别请求路径。OpenAI 请访问 /v1/chat/completions，Anthropic 请访问 /v1/messages。",
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
