import { NextResponse } from "next/server";
import { getLlm, updateLlm, deleteLlm } from "@/lib/db";
import type { LlmInput } from "@/lib/types";
import { normalizeLlmInput } from "@/lib/llm-input";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/llms/[id] */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const llm = getLlm(Number(id));
  if (!llm)
    return NextResponse.json(
      { ok: false, error: "未找到" },
      { status: 404 }
    );
  return NextResponse.json({ ok: true, data: llm });
}

/** PUT /api/llms/[id] */
export async function PUT(req: Request, { params }: Ctx) {
  const { id } = await params;
  const numId = Number(id);
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
    const updated = updateLlm(numId, input);
    if (!updated)
      return NextResponse.json(
        { ok: false, error: "未找到" },
        { status: 404 }
      );
    return NextResponse.json({ ok: true, data: updated });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("UNIQUE")) {
      return NextResponse.json(
        { ok: false, error: `别名 "${input.alias}" 已存在` },
        { status: 409 }
      );
    }
    if (
      msg.includes("CodeAgent 没有 Anthropic 后端") ||
      msg.includes("CodeAgent 配置必须填写 app_id")
    ) {
      return NextResponse.json(
        { ok: false, error: msg },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { ok: false, error: `更新失败：${msg}` },
      { status: 500 }
    );
  }
}

/** DELETE /api/llms/[id] */
export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const ok = deleteLlm(Number(id));
  if (!ok)
    return NextResponse.json({ ok: false, error: "未找到" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
