import type { LlmRow } from "./types";

type ListableModel = Pick<
  LlmRow,
  | "alias"
  | "name"
  | "enabled"
  | "created_at"
  | "anthropic_base_url"
  | "anthropic_supported"
>;

/**
 * OpenAI 与 Anthropic 都使用 GET /v1/models，因此用各 SDK 的标准请求头
 * 判断调用方协议。Anthropic SDK 会发送 anthropic-version；x-api-key 是对
 * 一些兼容客户端的兜底，并避免覆盖使用 Authorization 的 OpenAI 客户端。
 */
export function isAnthropicModelsRequest(headers: Headers): boolean {
  if (headers.has("anthropic-version") || headers.has("anthropic-beta")) {
    return true;
  }

  return headers.has("x-api-key") && !headers.has("authorization");
}

export function buildOpenAiModelsPayload(models: ListableModel[]) {
  const data = models
    .filter((model) => model.enabled === 1)
    .map((model) => ({
      id: model.alias,
      object: "model" as const,
      created: toUnixSec(model.created_at),
      owned_by: "llm-relay",
    }));

  return {
    object: "list" as const,
    data,
  };
}

export function buildAnthropicModelsPayload(models: ListableModel[]) {
  const data = models
    .filter(
      (model) =>
        model.enabled === 1 &&
        model.anthropic_base_url.trim() !== "" &&
        model.anthropic_supported !== 0,
    )
    .map((model) => ({
      id: model.alias,
      created_at: toIsoDate(model.created_at),
      display_name: model.name || model.alias,
      type: "model" as const,
      // Relay 无法可靠获知每个第三方上游的这些限制。
      capabilities: null,
      max_input_tokens: null,
      max_tokens: null,
    }));

  return {
    data,
    first_id: data.at(0)?.id ?? null,
    has_more: false,
    last_id: data.at(-1)?.id ?? null,
  };
}

export function createModelsResponse(
  request: Request,
  models: ListableModel[],
): Response {
  const payload = isAnthropicModelsRequest(request.headers)
    ? buildAnthropicModelsPayload(models)
    : buildOpenAiModelsPayload(models);

  return Response.json(payload, {
    headers: {
      Vary: "anthropic-version, anthropic-beta, x-api-key, authorization",
    },
  });
}

function toUnixSec(iso: string): number {
  const time = Date.parse(iso);
  return Number.isNaN(time) ? 0 : Math.floor(time / 1000);
}

function toIsoDate(value: string): string {
  const time = Date.parse(value);
  return Number.isNaN(time)
    ? new Date(0).toISOString()
    : new Date(time).toISOString();
}
