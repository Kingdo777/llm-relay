import { NextResponse } from "next/server";
import { listLogs } from "@/lib/db";

/** GET /api/logs?llmId=&status=&limit=&offset= */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const llmId = url.searchParams.get("llmId");
  const status = url.searchParams.get("status");
  const limit = url.searchParams.get("limit");
  const offset = url.searchParams.get("offset");

  const { rows, total } = listLogs({
    llmId: llmId ? Number(llmId) : undefined,
    status: status || undefined,
    limit: limit ? Number(limit) : undefined,
    offset: offset ? Number(offset) : undefined,
  });
  return NextResponse.json({ ok: true, data: rows, total });
}
