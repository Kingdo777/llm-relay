import { NextResponse } from "next/server";
import { listLlms, createLlm } from "@/lib/db";
import type { LlmInput } from "@/lib/types";
import { normalizeLlmInput } from "@/lib/llm-input";

/** GET /api/llms —— 列表 */
export async function GET() {
  return NextResponse.json({ ok: true, data: listLlms() });
}

/** POST /api/llms —— 新增 */
export async function POST(req: Request) {
  let body: Partial<LlmInput>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "请求体不是合法 JSON" },
      { status: 400 }
    );
  }

  const normalized = normalizeLlmInput(body);
  if ("error" in normalized) {
    return NextResponse.json(
      { ok: false, error: normalized.error },
      { status: 400 }
    );
  }
  const { input } = normalized;

  try {
    const created = createLlm(input);
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("UNIQUE")) {
      return NextResponse.json(
        { ok: false, error: `别名 "${input.alias}" 已存在` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: `创建失败：${msg}` },
      { status: 500 }
    );
  }
}
