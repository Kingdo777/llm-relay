import { NextResponse } from "next/server";
import { getLlm, updateLlm, deleteLlm } from "@/lib/db";
import type { LlmInput } from "@/lib/types";

interface Ctx {
  params: Promise<{ id: string }>;
}

function validAlias(a: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(a);
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

  const { name, alias, token, model_name, openai_base_url, anthropic_base_url } =
    body;
  if (!name || !alias || !token || !model_name) {
    return NextResponse.json(
      { ok: false, error: "name / alias / token / model_name 均为必填" },
      { status: 400 }
    );
  }
  if (!validAlias(alias)) {
    return NextResponse.json(
      {
        ok: false,
        error: "别名仅允许字母、数字、下划线、连字符、点",
      },
      { status: 400 }
    );
  }
  const oai = openai_base_url?.trim() || "";
  const ant = anthropic_base_url?.trim() || "";
  if (!oai && !ant) {
    return NextResponse.json(
      { ok: false, error: "两个 baseURL 至少填一个" },
      { status: 400 }
    );
  }

  try {
    const updated = updateLlm(numId, {
      name,
      alias,
      token,
      model_name,
      openai_base_url: oai || null,
      anthropic_base_url: ant || null,
      enabled: body.enabled,
    });
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
        { ok: false, error: `别名 "${alias}" 已存在` },
        { status: 409 }
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
