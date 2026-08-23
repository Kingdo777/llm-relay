import { NextResponse } from "next/server";
import { importLlms, listLlms } from "@/lib/db";
import { normalizeLlmInput } from "@/lib/llm-input";
import type { LlmInput } from "@/lib/types";

const FORMAT_VERSION = 1;
const MAX_IMPORT_COUNT = 500;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

/** GET /api/llms/import-export —— 下载完整 LLM 配置（包含 Token）。 */
export async function GET() {
  const llms = listLlms().map((llm) => ({
    name: llm.name,
    alias: llm.alias,
    url_mode: llm.url_mode,
    base_url: llm.base_url,
    openai_base_url: llm.openai_base_url,
    anthropic_base_url: llm.anthropic_base_url,
    token: llm.token,
    model_name: llm.model_name,
    enabled: llm.enabled === 1,
  }));
  const date = new Date().toISOString().slice(0, 10);

  return new Response(
    JSON.stringify(
      {
        format: "llm-relay-config",
        version: FORMAT_VERSION,
        exported_at: new Date().toISOString(),
        llms,
      },
      null,
      2
    ),
    {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="llm-relay-config-${date}.json"`,
        "cache-control": "no-store",
      },
    }
  );
}

/** POST /api/llms/import-export —— alias 冲突时跳过，其余新增。 */
export async function POST(req: Request) {
  const contentLength = Number(req.headers.get("content-length") ?? 0);
  if (contentLength > MAX_IMPORT_BYTES) {
    return NextResponse.json(
      { ok: false, error: "导入文件不能超过 2 MB" },
      { status: 413 }
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { ok: false, error: "导入文件不是合法 JSON" },
      { status: 400 }
    );
  }

  if (!isRecord(body) || body.format !== "llm-relay-config") {
    return NextResponse.json(
      { ok: false, error: "不是 llm-relay 配置文件" },
      { status: 400 }
    );
  }
  if (body.version !== FORMAT_VERSION) {
    return NextResponse.json(
      { ok: false, error: `不支持的配置文件版本：${String(body.version)}` },
      { status: 400 }
    );
  }
  if (!Array.isArray(body.llms) || body.llms.length === 0) {
    return NextResponse.json(
      { ok: false, error: "配置文件中没有 LLM 配置" },
      { status: 400 }
    );
  }
  if (body.llms.length > MAX_IMPORT_COUNT) {
    return NextResponse.json(
      { ok: false, error: `单次最多导入 ${MAX_IMPORT_COUNT} 个 LLM` },
      { status: 400 }
    );
  }

  const inputs: LlmInput[] = [];
  const aliases = new Set<string>();
  let duplicateCount = 0;
  for (let index = 0; index < body.llms.length; index += 1) {
    const item = body.llms[index];
    if (!isRecord(item)) {
      return invalidItem(index, "配置项必须是对象");
    }
    if (item.enabled !== undefined && typeof item.enabled !== "boolean") {
      return invalidItem(index, "enabled 必须是布尔值");
    }

    let normalized: ReturnType<typeof normalizeLlmInput>;
    try {
      normalized = normalizeLlmInput(item as Partial<LlmInput>);
    } catch (error) {
      return invalidItem(index, `字段格式错误：${(error as Error).message}`);
    }
    if ("error" in normalized) {
      return invalidItem(index, normalized.error);
    }
    if (aliases.has(normalized.input.alias)) {
      duplicateCount += 1;
      continue;
    }
    aliases.add(normalized.input.alias);
    inputs.push(normalized.input);
  }

  try {
    const result = importLlms(inputs);
    return NextResponse.json({
      ok: true,
      data: {
        created: result.created,
        skipped: result.skipped + duplicateCount,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: `导入失败：${(error as Error).message}` },
      { status: 500 }
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidItem(index: number, error: string) {
  return NextResponse.json(
    { ok: false, error: `第 ${index + 1} 项配置无效：${error}` },
    { status: 400 }
  );
}

export const dynamic = "force-dynamic";
