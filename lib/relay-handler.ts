import { NextResponse } from "next/server";
import { getLlmByAlias } from "@/lib/db";
import {
  relayRequest,
  parseAliasFromRequest,
  parseProtocolFromRequest,
} from "@/lib/proxy";
import type { Protocol } from "@/lib/types";
import { resolveRoute } from "@/lib/route-plan";

function protocolError(
  protocol: Protocol,
  message: string,
  status: number
): Response {
  if (protocol === "anthropic") {
    return NextResponse.json(
      { type: "error", error: { type: "invalid_request_error", message } },
      { status }
    );
  }
  return NextResponse.json(
    {
      error: {
        message,
        type: "invalid_request_error",
        param: null,
        code: String(status),
      },
    },
    { status }
  );
}

/**
 * 中转处理。
 *
 * 客户端协议由请求路径决定：
 *   /v1/chat/completions → openai
 *   /v1/responses        → openai-responses
 *   /v1/messages          → anthropic
 *
 * route_mode 决定保持同协议，或在 OpenAI 与 Anthropic 之间转换路由。
 */
export async function handleRelay(
  req: Request,
  pathForProtocol: string
): Promise<Response> {
  // 1) 路径决定客户端协议
  const protoParsed = parseProtocolFromRequest(pathForProtocol);
  if ("error" in protoParsed) {
    return NextResponse.json(
      { ok: false, error: protoParsed.error },
      { status: 400 }
    );
  }
  const clientProtocol: Protocol = protoParsed.protocol;

  // 2) 读取请求体
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  // 3) 从 model 找别名 → 找 LLM
  const aliasParsed = parseAliasFromRequest(rawBody);
  if ("error" in aliasParsed) {
    return protocolError(clientProtocol, aliasParsed.error, 400);
  }
  const llm = getLlmByAlias(aliasParsed.alias);
  if (!llm) {
    return protocolError(
      clientProtocol,
      `未找到别名（model）为 "${aliasParsed.alias}" 的 LLM，或该 LLM 已禁用。请检查客户端 model 填的值。`,
      404
    );
  }

  // 4) 按 route_mode 解析目标协议与 Base URL。
  const resolved = resolveRoute(llm, clientProtocol);
  if ("error" in resolved) {
    return protocolError(clientProtocol, resolved.error, 422);
  }
  // 5) 执行中转
  const result = await relayRequest(
    llm,
    resolved.plan,
    req.method,
    req.headers,
    rawBody,
    req.signal
  );
  return result.response;
}
