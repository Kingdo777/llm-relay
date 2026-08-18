import { NextResponse } from "next/server";
import { getDashboardStats } from "@/lib/db";

/** GET /api/stats —— 近 24 小时模型吞吐、成功率与延迟统计。 */
export async function GET() {
  return NextResponse.json(
    { ok: true, data: getDashboardStats() },
    { headers: { "cache-control": "no-store" } }
  );
}

export const dynamic = "force-dynamic";
