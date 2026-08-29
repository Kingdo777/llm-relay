import type { BaseUrlMode, LlmInput, RouteMode } from "./types";
import { normalizeCodeAgentBaseUrl } from "./format";

const ROUTE_MODES = new Set<RouteMode>([
  "off",
  "anthropic-to-openai",
  "openai-to-anthropic",
]);

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
  if (body.route_mode !== undefined && !ROUTE_MODES.has(body.route_mode)) {
    return {
      error:
        "路由模式必须是 off、anthropic-to-openai 或 openai-to-anthropic",
    };
  }
  if (body.app_id !== undefined && typeof body.app_id !== "string") {
    return { error: "app_id 必须是字符串" };
  }
  if (
    body.is_code_agent !== undefined &&
    typeof body.is_code_agent !== "boolean"
  ) {
    return { error: "is_code_agent 必须是布尔值" };
  }
  const appId = body.app_id?.trim();
  const routeMode =
    body.route_mode ??
    (body.is_code_agent === true ? "anthropic-to-openai" : undefined);
  if (body.is_code_agent === true && !appId) {
    return { error: "CodeAgent 配置必须填写 app_id" };
  }
  if (body.is_code_agent === true && routeMode === "openai-to-anthropic") {
    return { error: "CodeAgent 没有 Anthropic 后端，不能使用 O→A 路由" };
  }

  const mode: BaseUrlMode = body.url_mode === "separate" ? "separate" : "unified";
  if (mode === "unified") {
    const rawBaseUrl = (
      body.base_url ?? body.openai_base_url ?? body.anthropic_base_url ?? ""
    ).trim();
    if (!rawBaseUrl) return { error: "合一模式下 Base URL 为必填" };
    if (!validBaseUrl(rawBaseUrl)) {
      return { error: "Base URL 必须是合法的 http:// 或 https:// 地址" };
    }
    const baseUrl = body.is_code_agent
      ? normalizeCodeAgentBaseUrl(rawBaseUrl)
      : rawBaseUrl;
    return {
      input: {
        name,
        alias,
        token,
        model_name: modelName,
        url_mode: mode,
        route_mode: routeMode,
        base_url: baseUrl,
        openai_base_url: baseUrl,
        anthropic_base_url: baseUrl,
        enabled: body.enabled,
        is_code_agent: body.is_code_agent,
        app_id: appId,
      },
    };
  }

  const rawOpenaiBaseUrl = body.openai_base_url?.trim() ?? "";
  const rawAnthropicBaseUrl = body.anthropic_base_url?.trim() ?? "";
  if (!rawOpenaiBaseUrl || !rawAnthropicBaseUrl) {
    return { error: "分离模式下 OpenAI 与 Anthropic Base URL 均为必填" };
  }
  if (!validBaseUrl(rawOpenaiBaseUrl) || !validBaseUrl(rawAnthropicBaseUrl)) {
    return { error: "两个 Base URL 都必须是合法的 http:// 或 https:// 地址" };
  }
  const openaiBaseUrl = body.is_code_agent
    ? normalizeCodeAgentBaseUrl(rawOpenaiBaseUrl)
    : rawOpenaiBaseUrl;
  const anthropicBaseUrl = body.is_code_agent
    ? normalizeCodeAgentBaseUrl(rawAnthropicBaseUrl)
    : rawAnthropicBaseUrl;
  return {
    input: {
      name,
      alias,
      token,
      model_name: modelName,
      url_mode: mode,
      route_mode: routeMode,
      base_url: openaiBaseUrl,
      openai_base_url: openaiBaseUrl,
      anthropic_base_url: anthropicBaseUrl,
      enabled: body.enabled,
      is_code_agent: body.is_code_agent,
      app_id: appId,
    },
  };
}
