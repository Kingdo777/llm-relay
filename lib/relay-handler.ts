import { NextResponse } from "next/server";
import { getLlmByAlias } from "@/lib/db";
import {
  relayRequest,
  pickBackend,
  parseAliasFromRequest,
  parseProtocolFromRequest,
} from "@/lib/proxy";
import type { Protocol } from "@/lib/types";

/**
 * 中转处理。
 *
 * 客户端协议由请求路径决定：
 *   /v1/chat/completions → openai
 *   /v1/responses        → openai-responses
 *   /v1/messages          → anthropic
 *
 * OpenAI Chat / Responses 使用 OpenAI Base URL，Anthropic 使用其独立 URL。
 * 全程同格式透传，不执行协议转换。
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
    return NextResponse.json(
      { ok: false, error: aliasParsed.error },
      { status: 400 }
    );
  }
  const llm = getLlmByAlias(aliasParsed.alias);
  if (!llm) {
    return NextResponse.json(
      {
        ok: false,
        error: `未找到别名（model）为 "${aliasParsed.alias}" 的 LLM，或该 LLM 已禁用。请检查客户端 model 填的值。`,
      },
      { status: 404 }
    );
  }

  // 4) 严格按客户端协议选择同协议后端
  const backend = pickBackend(llm, clientProtocol);
  if (!backend) {
    return NextResponse.json(
      {
        ok: false,
        error: `LLM「${llm.name}」没有配置 ${clientProtocol === "anthropic" ? "Anthropic" : "OpenAI"} Base URL。`,
      },
      { status: 422 }
    );
  }
  // 5) 执行中转
  const result = await relayRequest(
    llm,
    clientProtocol,
    backend.backendProtocol,
    backend.baseUrl,
    req.method,
    req.headers,
    rawBody
  );
  return result.response;
}
