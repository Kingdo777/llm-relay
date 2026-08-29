import { NextResponse } from "next/server";
import {
  CodeAgentScriptError,
  loadCodeAgentConfigs,
} from "@/lib/code-agent-script";
import { upsertLlmsByAlias } from "@/lib/db";

/**
 * POST /api/llms/code-agent —— 执行脚本一次，全量校验后按 alias 批量新增或更新。
 * 脚本本次未返回的已有 LLM 不会被删除或禁用。
 */
export async function POST() {
  let configs: Awaited<ReturnType<typeof loadCodeAgentConfigs>>;
  try {
    configs = await loadCodeAgentConfigs();
  } catch (error) {
    logScriptError(error);
    return NextResponse.json(
      { ok: false, error: "CodeAgent 配置脚本执行或解析失败" },
      { status: 502 }
    );
  }

  if (configs.length === 0) {
    return NextResponse.json(
      { ok: false, error: "找不到 CodeAgent 配置" },
      { status: 404 }
    );
  }

  try {
    const result = upsertLlmsByAlias(configs);
    return NextResponse.json({ ok: true, data: result });
  } catch {
    return NextResponse.json(
      { ok: false, error: "CodeAgent 配置保存失败" },
      { status: 500 }
    );
  }
}

function logScriptError(error: unknown): void {
  if (error instanceof CodeAgentScriptError) {
    // Error 由本模块构造，不含 stdout/stderr，避免 Token 进入服务端日志。
    console.error(`CodeAgent 配置脚本错误 [${error.code}]：${error.message}`);
    return;
  }
  console.error("CodeAgent 配置脚本错误 [unknown]");
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
