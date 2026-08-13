import { NextResponse } from "next/server";
import { getLlm } from "@/lib/db";
import { testLlm } from "@/lib/test-llm";
import type { Protocol } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/llms/[id]/test?protocol=openai|anthropic
 *
 * 按指定协议测试；不指定时自动选 LLM 已配置的协议（OpenAI 优先）。
 */
export async function POST(req: Request, { params }: Ctx) {
  const { id } = await params;
  const llm = getLlm(Number(id));
  if (!llm)
    return NextResponse.json(
      { ok: false, error: "未找到该 LLM" },
      { status: 404 }
    );

  const url = new URL(req.url);
  const protoParam = url.searchParams.get("protocol") as Protocol | null;

  let protocol: Protocol;
  if (protoParam === "openai" || protoParam === "anthropic") {
    protocol = protoParam;
  } else if (llm.openai_base_url) {
    protocol = "openai";
  } else if (llm.anthropic_base_url) {
    protocol = "anthropic";
  } else {
    return NextResponse.json(
      { ok: false, error: "该 LLM 未配置任何 baseURL" },
      { status: 400 }
    );
  }

  const result = await testLlm(llm, protocol);
  return NextResponse.json({ ok: true, data: result });
}
