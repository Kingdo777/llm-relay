import { NextResponse } from "next/server";
import { importLlms, listLlms } from "@/lib/db";
import { normalizeLlmInput } from "@/lib/llm-input";
import type { LlmInput } from "@/lib/types";
import { Unzip, UnzipInflate } from "fflate";

const FORMAT_VERSION = 4;
const SUPPORTED_FORMAT_VERSIONS = new Set([1, 2, 3, FORMAT_VERSION]);
const MAX_IMPORT_COUNT = 500;
const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 64;
const ZIP_INPUT_CHUNK_BYTES = 512;

/** GET /api/llms/import-export —— 下载完整 LLM 配置（包含 Token）。 */
export async function GET() {
  const llms = listLlms().map((llm) => ({
    name: llm.name,
    alias: llm.alias,
    url_mode: llm.url_mode,
    route_mode: llm.route_mode,
    base_url: llm.base_url,
    openai_base_url: llm.openai_base_url,
    anthropic_base_url: llm.anthropic_base_url,
    token: llm.token,
    is_code_agent: llm.is_code_agent === 1,
    app_id: llm.app_id,
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

/** POST /api/llms/import-export —— 支持 JSON/ZIP；alias 冲突时跳过。 */
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
    body = await readImportBody(req);
  } catch (error) {
    const importError =
      error instanceof ImportFileError
        ? error
        : new ImportFileError("无法读取导入文件");
    return NextResponse.json(
      { ok: false, error: importError.message },
      { status: importError.status }
    );
  }

  if (!isRecord(body) || body.format !== "llm-relay-config") {
    return NextResponse.json(
      { ok: false, error: "不是 llm-relay 配置文件" },
      { status: 400 }
    );
  }
  if (
    typeof body.version !== "number" ||
    !SUPPORTED_FORMAT_VERSIONS.has(body.version)
  ) {
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
      // v1-v3 没有显式供应商字段。仅在导入旧文件时沿用历史 app_id
      // 语义完成一次性转换；v4 起 app_id 不再决定供应商类型。
      const legacyIsCodeAgent =
        body.version < FORMAT_VERSION &&
        typeof item.app_id === "string" &&
        item.app_id.trim() !== "";
      normalized = normalizeLlmInput({
        ...(item as Partial<LlmInput>),
        is_code_agent:
          body.version < FORMAT_VERSION
            ? legacyIsCodeAgent
            : (item.is_code_agent as boolean | undefined),
      });
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

class ImportFileError extends Error {
  constructor(
    message: string,
    readonly status = 400
  ) {
    super(message);
  }
}

async function readImportBody(req: Request): Promise<unknown> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await req.arrayBuffer());
  } catch {
    throw new ImportFileError("无法读取导入文件");
  }
  if (bytes.byteLength > MAX_IMPORT_BYTES) {
    throw new ImportFileError("导入文件不能超过 2 MB", 413);
  }
  if (isZip(bytes)) return readConfigFromZip(bytes);
  if (req.headers.get("content-type")?.toLowerCase().includes("zip")) {
    throw new ImportFileError("ZIP 文件损坏或格式不受支持");
  }
  return parseJsonBytes(bytes, "导入文件不是合法 JSON");
}

function isZip(bytes: Uint8Array): boolean {
  if (bytes.byteLength < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    return false;
  }
  return (
    (bytes[2] === 0x03 && bytes[3] === 0x04) ||
    (bytes[2] === 0x05 && bytes[3] === 0x06) ||
    (bytes[2] === 0x07 && bytes[3] === 0x08)
  );
}

function readConfigFromZip(bytes: Uint8Array): unknown {
  let entryCount = 0;
  let declaredJsonBytes = 0;
  let actualJsonBytes = 0;
  let failure: ImportFileError | null = null;
  const files: Uint8Array[] = [];
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > MAX_ZIP_ENTRIES) {
      throw new ImportFileError(
        `ZIP 文件条目不能超过 ${MAX_ZIP_ENTRIES} 个`
      );
    }

    const normalizedName = file.name.replaceAll("\\", "/");
    const pathParts = normalizedName.split("/");
    const fileName = pathParts.at(-1) ?? "";
    const isMetadata =
      pathParts.includes("__MACOSX") || fileName.startsWith("._");
    const isJson =
      !isMetadata &&
      !normalizedName.endsWith("/") &&
      fileName.toLowerCase().endsWith(".json");
    if (!isJson) return;

    if (file.originalSize !== undefined) {
      declaredJsonBytes += file.originalSize;
      if (
        file.originalSize > MAX_IMPORT_BYTES ||
        declaredJsonBytes > MAX_IMPORT_BYTES
      ) {
        throw new ImportFileError(
          "ZIP 中的 JSON 配置解压后不能超过 2 MB",
          413
        );
      }
    }

    let fileBytes = 0;
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (failure) {
        file.terminate();
        return;
      }
      if (error) {
        failure = new ImportFileError("ZIP 文件损坏或格式不受支持");
        file.terminate();
        return;
      }
      fileBytes += chunk.byteLength;
      actualJsonBytes += chunk.byteLength;
      if (
        fileBytes > MAX_IMPORT_BYTES ||
        actualJsonBytes > MAX_IMPORT_BYTES
      ) {
        failure = new ImportFileError(
          "ZIP 中的 JSON 配置解压后不能超过 2 MB",
          413
        );
        file.terminate();
        return;
      }
      if (chunk.byteLength > 0) chunks.push(chunk.slice());
      if (final) files.push(concatBytes(chunks, fileBytes));
    };
    file.start();
  });
  unzip.register(UnzipInflate);

  try {
    for (let offset = 0; offset < bytes.byteLength && !failure; ) {
      const end = Math.min(offset + ZIP_INPUT_CHUNK_BYTES, bytes.byteLength);
      unzip.push(bytes.subarray(offset, end), end === bytes.byteLength);
      offset = end;
    }
  } catch (error) {
    if (error instanceof ImportFileError) throw error;
    throw new ImportFileError("ZIP 文件损坏或格式不受支持");
  }
  if (failure) throw failure;

  const configs: unknown[] = [];
  for (const data of files) {
    try {
      const value = parseJsonBytes(data, "ZIP 中的 JSON 文件格式无效");
      if (isRecord(value) && value.format === "llm-relay-config") {
        configs.push(value);
      }
    } catch {
      // ZIP 可以包含说明或元数据 JSON；只选择合法的 llm-relay 配置。
    }
  }
  if (configs.length === 0) {
    throw new ImportFileError("ZIP 中没有找到 llm-relay JSON 配置");
  }
  if (configs.length > 1) {
    throw new ImportFileError("ZIP 中包含多个 llm-relay JSON 配置");
  }
  return configs[0];
}

function concatBytes(chunks: Uint8Array[], size: number): Uint8Array {
  const combined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

function parseJsonBytes(bytes: Uint8Array, errorMessage: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ImportFileError(errorMessage);
  }
  try {
    return JSON.parse(text.replace(/^\uFEFF/, "")) as unknown;
  } catch {
    throw new ImportFileError(errorMessage);
  }
}

export const dynamic = "force-dynamic";
