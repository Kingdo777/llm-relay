import "server-only";
import { execFile } from "node:child_process";
import path from "node:path";
import { parseCodeAgentPayload } from "./code-agent-config";
import type { LlmInput } from "./types";

const SCRIPT_PATH = path.join(
  process.cwd(),
  "scripts",
  "code_agent_config.py"
);
const PYTHON_COMMAND = process.env.CODE_AGENT_PYTHON?.trim() || "python3";
const SCRIPT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
let inFlightLoad: Promise<LlmInput[]> | null = null;

export type CodeAgentScriptErrorCode =
  | "not_found"
  | "timeout"
  | "output_too_large"
  | "execution_failed"
  | "empty_output"
  | "invalid_json"
  | "invalid_config";

/** 仅包含安全错误分类与说明，不携带脚本 stdout/stderr。 */
export class CodeAgentScriptError extends Error {
  constructor(
    readonly code: CodeAgentScriptErrorCode,
    message: string
  ) {
    super(message);
    this.name = "CodeAgentScriptError";
  }
}

/**
 * 每次调用都重新执行固定 Python 脚本，便于内网直接热替换脚本文件。
 * stdout 必须是精简配置对象；合法的空 models 表示未找到配置。
 */
export function loadCodeAgentConfigs(): Promise<LlmInput[]> {
  if (inFlightLoad) return inFlightLoad;

  const current = loadCodeAgentConfigsOnce();
  inFlightLoad = current;
  current.then(clearCurrent, clearCurrent);
  return current;

  function clearCurrent(): void {
    if (inFlightLoad === current) inFlightLoad = null;
  }
}

async function loadCodeAgentConfigsOnce(): Promise<LlmInput[]> {
  const stdout = await runConfigScript();
  const text = stdout.trim();
  if (!text) {
    throw new CodeAgentScriptError(
      "empty_output",
      "脚本没有输出 JSON 配置对象"
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new CodeAgentScriptError(
      "invalid_json",
      "脚本 stdout 不是合法 JSON"
    );
  }

  const parsed = parseCodeAgentPayload(value);
  if ("error" in parsed) {
    throw new CodeAgentScriptError("invalid_config", parsed.error);
  }
  return parsed.inputs;
}

function runConfigScript(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      /* turbopackIgnore: true */
      PYTHON_COMMAND,
      [SCRIPT_PATH],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: SCRIPT_TIMEOUT_MS,
        maxBuffer: MAX_OUTPUT_BYTES,
        windowsHide: true,
        killSignal: "SIGKILL",
      },
      (error, stdout) => {
        if (!error) {
          resolve(stdout);
          return;
        }

        const details = error as NodeJS.ErrnoException & {
          killed?: boolean;
          signal?: string;
        };
        if (details.code === "ENOENT") {
          reject(
            new CodeAgentScriptError(
              "not_found",
              "未找到 Python 解释器或 CodeAgent 配置脚本"
            )
          );
        } else if (details.killed || details.signal === "SIGKILL") {
          reject(
            new CodeAgentScriptError(
              "timeout",
              `CodeAgent 配置脚本执行超过 ${SCRIPT_TIMEOUT_MS / 1000} 秒`
            )
          );
        } else if (details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(
            new CodeAgentScriptError(
              "output_too_large",
              "CodeAgent 配置脚本输出超过 2 MB"
            )
          );
        } else {
          reject(
            new CodeAgentScriptError(
              "execution_failed",
              "CodeAgent 配置脚本执行失败"
            )
          );
        }
      }
    );
  });
}
