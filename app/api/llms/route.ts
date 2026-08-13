import { NextResponse } from "next/server";
import { listLlms, createLlm } from "@/lib/db";
import type { LlmInput } from "@/lib/types";

/** GET /api/llms —— 列表 */
export async function GET() {
  return NextResponse.json({ ok: true, data: listLlms() });
}

/** 别名合法性：仅字母数字下划线连字符 */
function validAlias(a: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(a);
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
        error: "别名仅允许字母、数字、下划线、连字符、点（作为对外模型名）",
      },
      { status: 400 }
    );
  }

  const oai = openai_base_url?.trim() || "";
  const ant = anthropic_base_url?.trim() || "";
  if (!oai && !ant) {
    return NextResponse.json(
      {
        ok: false,
        error: "OpenAI baseURL 和 Anthropic baseURL 至少填一个",
      },
      { status: 400 }
    );
  }

  try {
    const created = createLlm({
      name,
      alias,
      token,
      model_name,
      openai_base_url: oai || null,
      anthropic_base_url: ant || null,
      enabled: body.enabled,
    });
    return NextResponse.json({ ok: true, data: created }, { status: 201 });
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("UNIQUE")) {
      return NextResponse.json(
        { ok: false, error: `别名 "${alias}" 已存在` },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { ok: false, error: `创建失败：${msg}` },
      { status: 500 }
    );
  }
}
