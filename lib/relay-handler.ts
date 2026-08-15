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
 * 后端协议由该 LLM 配置的 baseURL 决定：
 *   - 配了与客户端同协议的 baseURL → 同格式透传
 *   - 未配置同协议 baseURL → 报错，不执行格式转换
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
