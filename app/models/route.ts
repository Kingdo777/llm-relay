import { NextResponse } from "next/server";
import { listLlms } from "@/lib/db";

/**
 * GET /models —— /v1/models 的兼容入口。
 *
 * 部分客户端会直接请求 /models（不拼 /v1）拉取模型列表。
 * 返回格式与 /v1/models 一致。
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
