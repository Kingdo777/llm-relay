import { NextResponse } from "next/server";
import { getDashboardStats } from "@/lib/db";

/** GET /api/stats —— 近 24 小时模型吞吐、成功率与延迟统计。
 * 可用 ?bucket= 指定趋势序列聚合粒度（分钟），如 1/10/30/60。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("bucket");
  const parsed = raw ? Number(raw) : 1;
  const bucket =
    Number.isFinite(parsed) && parsed > 0 && Number.isInteger(parsed) ? parsed : 1;
  try {
    return NextResponse.json(
      { ok: true, data: getDashboardStats(new Date(), bucket) },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (error) {
    console.error("Failed to load dashboard stats", error);
    return NextResponse.json(
      { ok: false, error: `统计加载失败：${(error as Error).message}` },
      { status: 500, headers: { "cache-control": "no-store" } }
    );
  }
}

export const dynamic = "force-dynamic";
