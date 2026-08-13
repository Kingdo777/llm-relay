import { NextResponse } from "next/server";
import { getLog } from "@/lib/db";

interface Ctx {
  params: Promise<{ id: string }>;
}

/** GET /api/logs/[id] —— 单条日志详情 */
export async function GET(_req: Request, { params }: Ctx) {
  const { id } = await params;
  const log = getLog(Number(id));
  if (!log)
    return NextResponse.json({ ok: false, error: "未找到" }, { status: 404 });
  return NextResponse.json({ ok: true, data: log });
}
