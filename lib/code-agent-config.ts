import { createHash } from "node:crypto";
import { normalizeCodeAgentBaseUrl } from "./format";
import { normalizeLlmInput } from "./llm-input";
import type { LlmInput } from "./types";

const MAX_CONFIG_COUNT = 500;
export const CODE_AGENT_MODEL_PREFIX = "CodeAgent-";

export type ParseCodeAgentConfigsResult =
  | { inputs: LlmInput[] }
  | { error: string };

/**
 * 将 Python 脚本的精简对象展开为现有 LLM 配置列表。
 * 空 models 合法并表示未找到配置；非空时统一使用 access_token/api_base_url，
 * 展示名和 alias 添加 CodeAgent- 前缀，真实 model_name 保持脚本原值。
 */
export function parseCodeAgentPayload(
  value: unknown
): ParseCodeAgentConfigsResult {
  if (!isRecord(value)) {
    return { error: "脚本 JSON 顶层必须是配置对象" };
  }
  if (typeof value.access_token !== "string") {
    return { error: "access_token 必须是字符串" };
  }
  if (typeof value.appid !== "string") {
    return { error: "appid 必须是字符串" };
  }
  if (typeof value.api_base_url !== "string") {
    return { error: "api_base_url 必须是字符串" };
  }
  if (!Array.isArray(value.models)) {
    return { error: "models 必须是字符串数组" };
  }
  if (value.models.length > MAX_CONFIG_COUNT) {
    return { error: `脚本单次最多返回 ${MAX_CONFIG_COUNT} 个 LLM 配置` };
  }
  if (value.models.length === 0) return { inputs: [] };

  const accessToken = value.access_token.trim();
  const appId = value.appid.trim();
  const rawBaseUrl = value.api_base_url.trim();
  if (!accessToken) return { error: "models 非空时 access_token 不能为空" };
  if (!appId) return { error: "models 非空时 appid 不能为空" };
  if (!rawBaseUrl) return { error: "models 非空时 api_base_url 不能为空" };
  let baseUrl: string;
  try {
    baseUrl = normalizeCodeAgentBaseUrl(rawBaseUrl);
  } catch {
    return {
      error: "models 非空时 api_base_url 必须是合法的 http:// 或 https:// 地址",
    };
  }

  const inputs: LlmInput[] = [];
  const aliases = new Set<string>();
  for (let index = 0; index < value.models.length; index += 1) {
    const model = value.models[index];
    if (typeof model !== "string" || !model.trim()) {
      return invalidModel(index, "模型名必须是非空字符串");
    }
    const upstreamModel = model.trim();
    const displayName = `${CODE_AGENT_MODEL_PREFIX}${upstreamModel}`;
    const alias = codeAgentAlias(upstreamModel);

    let normalized: ReturnType<typeof normalizeLlmInput>;
    try {
      normalized = normalizeLlmInput({
        name: displayName,
        alias,
        url_mode: "unified",
        route_mode: "anthropic-to-openai",
        base_url: baseUrl,
        token: accessToken,
        app_id: appId,
        is_code_agent: true,
        model_name: upstreamModel,
        enabled: true,
      });
    } catch {
      return invalidModel(index, "字段格式错误");
    }
    if ("error" in normalized) {
      return invalidModel(index, normalized.error);
    }
    if (aliases.has(normalized.input.alias)) {
      return invalidModel(index, `模型 "${model.trim()}" 重复`);
    }
    aliases.add(normalized.input.alias);
    inputs.push(normalized.input);
  }

  return { inputs };
}

/** 简单模型名保持可读；特殊字符改为安全 slug，并加 hash 避免 slug 冲突。 */
function codeAgentAlias(model: string): string {
  const direct = `${CODE_AGENT_MODEL_PREFIX}${model}`;
  if (/^[A-Za-z0-9_.-]+$/.test(direct)) return direct;

  const slug = model
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "model";
  const hash = createHash("sha256").update(model).digest("hex").slice(0, 8);
  return `${CODE_AGENT_MODEL_PREFIX}${slug}-${hash}`;
}

function invalidModel(
  index: number,
  message: string
): { error: string } {
  return { error: `models 第 ${index + 1} 项无效：${message}` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
