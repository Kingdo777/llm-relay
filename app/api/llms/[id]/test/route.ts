import { NextResponse } from "next/server";
import { getLlm, updateProtocolSupport } from "@/lib/db";
import { testLlm } from "@/lib/test-llm";

interface Ctx {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/llms/[id]/test
 *
 * 使用各协议选定的 Base URL 并行探测 OpenAI（Chat Completions / Responses）
 * 与 Anthropic 三种协议的工具兼容性。
 */
export async function POST(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const llm = getLlm(Number(id));
  if (!llm)
    return NextResponse.json(
      { ok: false, error: "未找到该 LLM" },
      { status: 404 }
    );

	const [openai, openaiResponses, anthropic] = await Promise.all([
		testLlm(llm, "openai"),
		testLlm(llm, "openai-responses"),
		testLlm(llm, "anthropic"),
	]);
	const tested_at = new Date().toISOString();
	updateProtocolSupport(llm.id, openai.success, anthropic.success, openaiResponses.success, tested_at);
	return NextResponse.json({ ok: true, data: { openai, openaiResponses, anthropic, tested_at } });
}
