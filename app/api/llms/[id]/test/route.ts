import { NextResponse } from "next/server";
import { getLlm, updateProtocolSupport } from "@/lib/db";
import { testLlm } from "@/lib/test-llm";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/llms/[id]/test
 *
 * 使用同一个 Base URL 并行探测 OpenAI 与 Anthropic 工具协议。
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const llm = getLlm(Number(id));
  if (!llm)
    return NextResponse.json(
      { ok: false, error: "未找到该 LLM" },
      { status: 404 }
    );

	const [openai, anthropic] = await Promise.all([
		testLlm(llm, "openai"),
		testLlm(llm, "anthropic"),
	]);
	const tested_at = new Date().toISOString();
	updateProtocolSupport(llm.id, openai.success, anthropic.success, tested_at);
	return NextResponse.json({ ok: true, data: { openai, anthropic, tested_at } });
}
