import type { LlmRow, Protocol } from "./types";
import {
  buildUpstreamHeaders,
  buildUpstreamUrl,
  rewriteModel,
  upstreamPathForProtocol,
  inferProtocolFromPath,
  normalizeRequestToolTypes,
  extractModel,
  requestStreamUsage,
} from "./format";
import { insertLog, updateLog } from "./db";
import { compactLogInput } from "./log-parser";
import { extractTokenUsage } from "./usage";
import type { RoutePlan } from "./route-plan";
import {
  convertRoutedError,
  convertRoutedRequest,
  convertRoutedResponse,
  createRoutedStreamConverter,
  routeDescription,
  routedStreamErrorFrame,
} from "./route-conversion";
import type { RoutedConversionContext } from "./route-conversion";
import { fetchUpstreamWithToolTypeFallback } from "./upstream-fetch";

export interface RelayResult {
  response: Response;
  logId: number | null;
}

/** 输出文本入库的最大长度，超出截断，避免单条日志过大 */
const MAX_OUTPUT_LEN = 200_000;
/** 输入文本入库的最大长度 */
const MAX_INPUT_LEN = 200_000;
/** SSE 检查器只保留当前未结束事件，避免日志统计反向放大内存。 */
const MAX_SSE_INSPECTION_EVENT_LEN = 1024 * 1024;
/** 超大事件只检查开头的标准 event/data 元数据。 */
const MAX_SSE_METADATA_PREFIX_LEN = 4096;

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n…[已截断，原始长度 ${s.length}]`;
}

/** 仅保留日志前缀，同时持续统计客户端实际输出长度。 */
class BoundedLogOutput {
  private prefix = "";
  private totalLength = 0;

  constructor(private readonly maxLength: number) {}

  append(value: string): void {
    if (!value) return;
    this.totalLength += value.length;
    const remaining = this.maxLength - this.prefix.length;
    if (remaining > 0) this.prefix += value.slice(0, remaining);
  }

  render(): string {
    if (this.totalLength <= this.maxLength) return this.prefix;
    return `${this.prefix}\n…[已截断，原始长度 ${this.totalLength}]`;
  }
}

function detectStreamError(raw: string): string | null {
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const payload = JSON.parse(data) as Record<string, unknown>;
      const nested =
        payload.error && typeof payload.error === "object"
          ? (payload.error as Record<string, unknown>)
          : payload.response && typeof payload.response === "object"
            ? ((payload.response as Record<string, unknown>).error as
                | Record<string, unknown>
                | undefined)
            : undefined;
      if (payload.type === "error" || payload.type === "response.failed" || nested) {
        return typeof nested?.message === "string"
          ? nested.message
          : "上游流返回错误事件";
      }
    } catch {
      // 非 JSON data 不作为结构化错误处理。
    }
  }
  return null;
}

type ParsedUsage = NonNullable<ReturnType<typeof extractTokenUsage>>;

function mergeStreamUsage(
  current: ParsedUsage | null,
  next: ParsedUsage
): ParsedUsage {
  if (!current) return next;
  const inputTokens = Math.max(current.inputTokens, next.inputTokens);
  const outputTokens = Math.max(current.outputTokens, next.outputTokens);
  const cachedInputTokens =
    current.cachedInputTokens === null
      ? next.cachedInputTokens
      : next.cachedInputTokens === null
        ? current.cachedInputTokens
        : Math.max(current.cachedInputTokens, next.cachedInputTokens);
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: Math.max(
      current.totalTokens,
      next.totalTokens,
      inputTokens + outputTokens
    ),
  };
}

/**
 * 增量检查完整 SSE 事件。已完成事件立即释放；异常大的单个事件被跳过，
 * 因此 usage/error 统计不需要把整个上游响应常驻内存。
 */
class SseStreamInspection {
  private buffer = "";
  private discardingOversizedEvent = false;
  private oversizedMetadata: { terminal: boolean; failed: boolean } | null = null;
  private terminalSeen = false;
  usage: ParsedUsage | null = null;
  error: string | null = null;

  constructor(private readonly protocol: Protocol) {}

  push(value: string): void {
    if (!value) return;
    this.buffer += value;
    this.drain(false);
    if (this.buffer.length > MAX_SSE_INSPECTION_EVENT_LEN) {
      if (!this.discardingOversizedEvent) {
        this.oversizedMetadata = this.readEventMetadata(
          this.buffer.slice(0, MAX_SSE_METADATA_PREFIX_LEN)
        );
      }
      this.discardingOversizedEvent = true;
      // 足以识别跨 chunk 的 \r\n\r\n / \n\n 事件边界。
      this.buffer = this.buffer.slice(-3);
    }
  }

  finish(value = ""): void {
    this.push(value);
    this.drain(true);
  }

  missingTerminalError(): string | null {
    if (this.terminalSeen) return null;
    if (this.protocol === "openai") {
      return "OpenAI SSE 在 [DONE] 前结束";
    }
    if (this.protocol === "anthropic") {
      return "Anthropic SSE 在 message_stop 前结束";
    }
    return "Responses SSE 在终止事件前结束";
  }

  private drain(final: boolean): void {
    while (true) {
      const match = /\r?\n\r?\n/.exec(this.buffer);
      if (!match || match.index === undefined) break;
      if (this.discardingOversizedEvent) {
        this.applyEventMetadata(this.oversizedMetadata);
      } else if (match.index > MAX_SSE_INSPECTION_EVENT_LEN) {
        this.applyEventMetadata(
          this.readEventMetadata(
            this.buffer.slice(0, MAX_SSE_METADATA_PREFIX_LEN)
          )
        );
      } else {
        this.inspect(this.buffer.slice(0, match.index));
      }
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.discardingOversizedEvent = false;
      this.oversizedMetadata = null;
    }

    if (final && this.buffer.trim()) {
      // 被截断的超大事件没有真正边界，不能仅凭开头宣告成功。
      if (!this.discardingOversizedEvent) this.inspect(this.buffer);
      this.buffer = "";
      this.discardingOversizedEvent = false;
      this.oversizedMetadata = null;
    }
  }

  private inspect(event: string): void {
    if (
      this.discardingOversizedEvent ||
      event.length > MAX_SSE_INSPECTION_EVENT_LEN
    ) {
      return;
    }
    const usage = extractTokenUsage(event);
    if (usage) this.usage = mergeStreamUsage(this.usage, usage);
    if (!this.error) this.error = detectStreamError(event);
    this.inspectTerminal(event);
  }

  private inspectTerminal(event: string): void {
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of event.split(/\r?\n/)) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    const data = dataLines.join("\n").trim();
    if (this.protocol === "openai") {
      if (data === "[DONE]") this.terminalSeen = true;
      return;
    }

    let payloadType = "";
    try {
      const parsed = JSON.parse(data) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const type = (parsed as Record<string, unknown>).type;
        if (typeof type === "string") payloadType = type;
      }
    } catch {
      // 结构错误由透传客户端处理；这里只识别明确的协议终止标记。
    }

    if (this.protocol === "anthropic") {
      if (eventName === "message_stop" || payloadType === "message_stop") {
        this.terminalSeen = true;
      }
      return;
    }
    const responseTerminals = [
      "response.completed",
      "response.incomplete",
      "response.failed",
    ];
    if (
      responseTerminals.includes(eventName) ||
      responseTerminals.includes(payloadType)
    ) {
      this.terminalSeen = true;
    }
  }

  private readEventMetadata(
    prefix: string
  ): { terminal: boolean; failed: boolean } {
    const eventName = /^event:\s*([^\r\n]+)$/m.exec(prefix)?.[1]?.trim() ?? "";
    // 只接受 data JSON 的首个顶层字段，避免把正文里的 type 误判为事件类型。
    const payloadType =
      /^data:\s*\{\s*"type"\s*:\s*"([^"]+)"\s*[,}]/m.exec(prefix)?.[1] ??
      "";
    if (this.protocol === "anthropic") {
      return {
        terminal: eventName === "message_stop" || payloadType === "message_stop",
        failed: eventName === "error" || payloadType === "error",
      };
    }
    if (this.protocol === "openai-responses") {
      const terminals = [
        "response.completed",
        "response.incomplete",
        "response.failed",
      ];
      return {
        terminal:
          terminals.includes(eventName) || terminals.includes(payloadType),
        failed:
          eventName === "response.failed" ||
          payloadType === "response.failed" ||
          eventName === "error" ||
          payloadType === "error",
      };
    }
    return {
      terminal: false,
      failed:
        eventName === "error" ||
        payloadType === "error" ||
        /^data:\s*\{\s*"error"\s*:/m.test(prefix),
    };
  }

  private applyEventMetadata(
    metadata: { terminal: boolean; failed: boolean } | null
  ): void {
    if (!metadata) return;
    if (metadata.terminal) this.terminalSeen = true;
    if (metadata.failed && !this.error) {
      this.error = "上游流返回错误事件";
    }
  }
}

/**
 * 执行中转。
 *
 * @param llm            命中的 LLM
 * @param plan           客户端协议、目标协议与选用的 Base URL
 * @param method         HTTP 方法
 * @param originalHeaders 原始请求头
 * @param rawBody        原始请求体（客户端格式）
 */
export async function relayRequest(
  llm: LlmRow,
  plan: RoutePlan,
  method: string,
  originalHeaders: Headers,
  rawBody: string,
  clientSignal?: AbortSignal
): Promise<RelayResult> {
  const start = Date.now();
  const { clientProtocol, backendProtocol, baseUrl } = plan;

  const isCodeAgent = llm.is_code_agent === 1;
  const subPath = upstreamPathForProtocol(backendProtocol, isCodeAgent);
  const upstreamUrl = buildUpstreamUrl(baseUrl, subPath, {
    codeAgent: llm.is_code_agent === 1,
  });
  // 后端头始终按 backendProtocol 注入鉴权（同格式透传时等于 clientProtocol）
  const headers = buildUpstreamHeaders(
    backendProtocol,
    llm.token,
    originalHeaders,
    { appId: llm.app_id, codeAgent: isCodeAgent }
  );

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
    error: plan.routed ? `跨格式转换：${routeDescription(plan)}` : null,
    duration_ms: 0,
    status_code: null,
  });

  const rewritten = rewriteModel(rawBody, llm.model_name);
  const rewrittenBody = rewritten.ok ? rewritten.body : rawBody;
  let conversionContext: RoutedConversionContext | null = null;
  let convertedRequestBody = rewrittenBody;
  if (plan.routed) {
    try {
      const converted = convertRoutedRequest(rewrittenBody, plan, llm);
      convertedRequestBody = converted.body;
      conversionContext = converted.context;
    } catch (error) {
      const message = (error as Error).message || "请求格式无法转换";
      const status =
        typeof (error as { status?: unknown }).status === "number"
          ? (error as { status: number }).status
          : 400;
      updateLog(logId, {
        status: "failed",
        error: `协议路由请求转换失败：${message}`,
        duration_ms: Date.now() - start,
      });
      return {
        response: new Response(
          convertRoutedError(
            JSON.stringify({ error: { message } }),
            clientProtocol,
            status,
            "invalid_request_error"
          ),
          { status, headers: { "content-type": "application/json" } }
        ),
        logId,
      };
    }
  }
  const normalizedToolBody = normalizeRequestToolTypes(
    convertedRequestBody,
    backendProtocol
  );
  const outBody = requestStreamUsage(normalizedToolBody, backendProtocol);
  const backendRequestedStream = requestBodyStreams(outBody);
  if (plan.routed && !backendRequestedStream) {
    // 路由后以目标协议的 body 为准；不要让客户端遗留的 Accept 诱导兼容
    // 上游在 stream=false 时仍返回 SSE。
    headers.set("accept", "application/json");
  }

  let response: Response;
  let retriedAnthropicToolType = false;
  try {
    const fetched = await fetchUpstreamWithToolTypeFallback(upstreamUrl, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : outBody,
      signal: clientSignal,
    }, backendProtocol, outBody);
    response = fetched.response;
    retriedAnthropicToolType = fetched.retriedAnthropicToolType;
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
        convertRoutedError(
          JSON.stringify({ error: { message, type: "relay_error" } }),
          clientProtocol,
          502
        ),
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
  if (
    isSSE &&
    response.body &&
    response.ok &&
    (!plan.routed || backendRequestedStream)
  ) {
    const reader = response.body.getReader();
    const rawDecoder = new TextDecoder();
    const encoder = new TextEncoder();
    const streamConverter = plan.routed
      ? createRoutedStreamConverter(plan, llm, conversionContext!)
      : null;
    const logOutput = new BoundedLogOutput(MAX_OUTPUT_LEN);
    const inspection = new SseStreamInspection(backendProtocol);
    let finalized = false;
    let streamError = "";
    let firstByteMs: number | null = null;

    const finalize = () => {
      if (finalized) return;
      finalized = true;
      const duration_ms = Date.now() - start;
      if (!streamError) {
        streamError =
          inspection.error ??
          (!streamConverter ? inspection.missingTerminalError() : null) ??
          "";
      }
      const usage = inspection.usage;
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
      updateLog(logId, {
        status: streamError ? "failed" : "success",
        error: streamError
          ? `流式传输或转换中断：${streamError}`
          : plan.routed
            ? `跨格式转换：${routeDescription(plan)}`
            : retriedAnthropicToolType
              ? "Anthropic 工具类型兼容重试"
              : null,
        output: logOutput.render(),
        duration_ms,
        status_code: status,
        is_stream: 1,
        ...measurements,
      });
    };

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) {
            const rawTail = rawDecoder.decode();
            inspection.finish(rawTail);
            if (!streamConverter) logOutput.append(rawTail);
            if (streamConverter) {
              const tail = streamConverter.finish();
              if (tail) {
                logOutput.append(tail);
                controller.enqueue(encoder.encode(tail));
              }
              if (streamConverter.didFail?.()) {
                streamError = "上游流返回错误事件";
              }
            }
            controller.close();
            finalize();
            return;
          }
          if (firstByteMs === null && value.byteLength > 0) {
            firstByteMs = Date.now() - start;
          }
          const rawText = rawDecoder.decode(value, { stream: true });
          inspection.push(rawText);
          if (streamConverter) {
            const translated = streamConverter.feed(value);
            if (translated) {
              logOutput.append(translated);
              controller.enqueue(encoder.encode(translated));
            }
            if (streamConverter.didFail?.()) {
              streamError = "上游流返回错误事件";
              try {
                await reader.cancel(streamError);
              } catch {
                // 上游可能已自行关闭；仍以失败状态完成日志。
              }
              controller.close();
              finalize();
              return;
            }
          } else {
            logOutput.append(rawText);
            controller.enqueue(value);
          }
        } catch (error) {
          streamError = (error as Error).message;
          try {
            await reader.cancel(error);
          } catch {
            // 转换失败后尽力终止上游，cancel 自身错误不覆盖原始原因。
          }
          if (streamConverter) {
            const errorFrame = routedStreamErrorFrame(
              streamError,
              clientProtocol,
              streamConverter
            );
            if (errorFrame) {
              logOutput.append(errorFrame);
              controller.enqueue(encoder.encode(errorFrame));
            }
            controller.close();
          } else {
            controller.error(error);
          }
          finalize();
        }
      },
      async cancel(reason) {
        streamError = "客户端取消流式响应";
        try {
          await reader.cancel(reason);
        } catch (error) {
          streamError += `：${(error as Error).message}`;
        } finally {
          finalize();
        }
      },
    });

    const streamHeaders = plan.routed
      ? new Headers({
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache",
          connection: "keep-alive",
        })
      : respHeaders;
    return {
      response: new Response(stream, { status, headers: streamHeaders }),
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
        convertRoutedError(
          JSON.stringify({ error: { message: "读取上游响应失败" } }),
          clientProtocol,
          502
        ),
        { status: 502, headers: { "content-type": "application/json" } }
      ),
      logId,
    };
  }

  let clientText = bufText;
  if (plan.routed) {
    try {
      if (response.ok && isSSE && !backendRequestedStream) {
        throw new Error("上游忽略 stream=false 并返回 SSE，无法作为非流式 JSON 转换");
      }
      clientText = response.ok
        ? convertRoutedResponse(bufText, plan, llm, conversionContext!)
        : convertRoutedError(bufText, clientProtocol, status);
    } catch (error) {
      const message = (error as Error).message || "上游响应格式无法转换";
      const usage = extractTokenUsage(bufText);
      updateLog(logId, {
        status: "failed",
        error: `协议路由响应转换失败：${message}`,
        output: clamp(bufText, MAX_OUTPUT_LEN),
        duration_ms: Date.now() - start,
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
        response: new Response(
          convertRoutedError(
            JSON.stringify({ error: { message } }),
            clientProtocol,
            502
          ),
          { status: 502, headers: { "content-type": "application/json" } }
        ),
        logId,
      };
    }
    respHeaders.set("content-type", "application/json; charset=utf-8");
  }

  const duration_ms = Date.now() - start;
  const ok = status >= 200 && status < 300;
  const usage = extractTokenUsage(bufText);
  updateLog(logId, {
    status: ok ? "success" : "failed",
    error: ok
      ? plan.routed
        ? `跨格式转换：${routeDescription(plan)}${
            retriedAnthropicToolType ? "；工具类型兼容重试" : ""
          }`
        : retriedAnthropicToolType
          ? "Anthropic 工具类型兼容重试"
        : null
      : `上游 HTTP ${status}\n${bufText.slice(0, 2000)}`,
    output: clamp(clientText, MAX_OUTPUT_LEN),
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
    response: new Response(clientText, {
      status,
      headers: respHeaders,
    }),
    logId,
  };
}

function requestBodyStreams(body: string): boolean {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return parsed.stream === true;
  } catch {
    return false;
  }
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
