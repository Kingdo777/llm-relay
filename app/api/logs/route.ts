import { NextResponse } from "next/server";
import { deleteLogs, listLogs } from "@/lib/db";

function readFilters(req: Request): { llmId?: number; status?: string } {
  const url = new URL(req.url);
  const rawLlmId = url.searchParams.get("llmId");
  const status = url.searchParams.get("status");
  const llmId = rawLlmId ? Number(rawLlmId) : undefined;

  if (llmId !== undefined && (!Number.isInteger(llmId) || llmId <= 0)) {
    throw new Error("无效的 LLM ID");
  }
  if (status && !["success", "failed", "streaming"].includes(status)) {
    throw new Error("无效的日志状态");
  }
  return { llmId, status: status || undefined };
}

/** GET /api/logs?llmId=&status=&limit=&offset= */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  let filters: ReturnType<typeof readFilters>;
  try {
    filters = readFilters(req);
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 400 }
    );
  }

  const { rows, total } = listLogs({
    ...filters,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  return NextResponse.json({ ok: true, data: rows, total });
}

/** DELETE /api/logs?llmId=&status= —— 删除所有符合当前筛选条件的日志 */
export async function DELETE(req: Request) {
  try {
    const deleted = deleteLogs(readFilters(req));
    return NextResponse.json({ ok: true, deleted });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: (error as Error).message },
      { status: 400 }
    );
  }
}
