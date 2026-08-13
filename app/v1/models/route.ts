import { NextResponse } from "next/server";
import { listLlms } from "@/lib/db";

/**
 * GET /v1/models —— 返回所有启用的 LLM 别名作为模型列表。
 *
 * 兼容 OpenAI 客户端（如 NextChat/LobeChat）启动时拉取模型列表的行为，
 * 让它们能自动识别本中转站提供的"模型"（实际是 LLM 别名）。
 *
 * 返回格式遵循 OpenAI 的 /v1/models 规范。
 */
export async function GET() {
  const llms = listLlms().filter((l) => l.enabled);
  const data = llms.map((l) => ({
    id: l.alias,
    object: "model",
    created: toUnixSec(l.created_at),
    owned_by: "llm-relay",
  }));
  return NextResponse.json({
    object: "list",
    data,
  });
}

function toUnixSec(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : Math.floor(t / 1000);
}

export const dynamic = "force-dynamic";
