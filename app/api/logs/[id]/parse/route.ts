import { NextResponse } from "next/server";
import { cacheParsedLog, getLog } from "@/lib/db";
import { LOG_PARSER_VERSION, parseLog } from "@/lib/log-parser";

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function POST(_req: Request, { params }: Ctx) {
  const { id: rawId } = await params;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ ok: false, error: "无效日志 ID" }, { status: 400 });
  }

  const log = getLog(id);
  if (!log) return NextResponse.json({ ok: false, error: "未找到" }, { status: 404 });
  if (log.status === "streaming") {
    return NextResponse.json(
      { ok: false, error: "响应仍在生成中，请结束后再解析" },
      { status: 409 }
    );
  }

  if (log.parser_version === LOG_PARSER_VERSION && log.parsed_input && log.parsed_output) {
    return NextResponse.json({ ok: true, data: log, cached: true });
  }

  const { parsedInput, parsedOutput } = parseLog(log);
  const updated = cacheParsedLog(
    id,
    LOG_PARSER_VERSION,
    JSON.stringify(parsedInput),
    JSON.stringify(parsedOutput)
  );
  return NextResponse.json({ ok: true, data: updated, cached: false });
}
