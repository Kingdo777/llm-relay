import type { BaseUrlMode, LlmInput } from "./types";

function validAlias(alias: string): boolean {
  return /^[A-Za-z0-9_.-]+$/.test(alias);
}

function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !!url.host;
  } catch {
    return false;
  }
}

export function normalizeLlmInput(
  body: Partial<LlmInput>
): { input: LlmInput } | { error: string } {
  const name = body.name?.trim();
  const alias = body.alias?.trim();
  const token = body.token?.trim();
  const modelName = body.model_name?.trim();
  if (!name || !alias || !token || !modelName) {
    return { error: "name / alias / token / model_name 均为必填" };
  }
  if (!validAlias(alias)) {
    return { error: "别名仅允许字母、数字、下划线、连字符、点" };
  }
  if (body.url_mode && !["unified", "separate"].includes(body.url_mode)) {
    return { error: "Base URL 模式必须是 unified 或 separate" };
  }
  if (body.app_id !== undefined && typeof body.app_id !== "string") {
    return { error: "app_id 必须是字符串" };
  }
  const appId = body.app_id?.trim();

  const mode: BaseUrlMode = body.url_mode === "separate" ? "separate" : "unified";
  if (mode === "unified") {
    const baseUrl = (
      body.base_url ?? body.openai_base_url ?? body.anthropic_base_url ?? ""
    ).trim();
    if (!baseUrl) return { error: "合一模式下 Base URL 为必填" };
    if (!validBaseUrl(baseUrl)) {
      return { error: "Base URL 必须是合法的 http:// 或 https:// 地址" };
    }
    return {
      input: {
        name,
        alias,
        token,
        model_name: modelName,
        url_mode: mode,
        base_url: baseUrl,
        openai_base_url: baseUrl,
        anthropic_base_url: baseUrl,
        enabled: body.enabled,
        app_id: appId,
      },
    };
  }

  const openaiBaseUrl = body.openai_base_url?.trim() ?? "";
  const anthropicBaseUrl = body.anthropic_base_url?.trim() ?? "";
  if (!openaiBaseUrl || !anthropicBaseUrl) {
    return { error: "分离模式下 OpenAI 与 Anthropic Base URL 均为必填" };
  }
  if (!validBaseUrl(openaiBaseUrl) || !validBaseUrl(anthropicBaseUrl)) {
    return { error: "两个 Base URL 都必须是合法的 http:// 或 https:// 地址" };
  }
  return {
    input: {
      name,
      alias,
      token,
      model_name: modelName,
      url_mode: mode,
      base_url: openaiBaseUrl,
      openai_base_url: openaiBaseUrl,
      anthropic_base_url: anthropicBaseUrl,
      enabled: body.enabled,
      app_id: appId,
    },
  };
}
