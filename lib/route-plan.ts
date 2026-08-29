import type { LlmRow, Protocol, RouteMode } from "./types";

export interface RoutePlan {
  clientProtocol: Protocol;
  backendProtocol: Protocol;
  baseUrl: string;
  routed: boolean;
}

type RoutableLlm = Pick<
  LlmRow,
  | "name"
  | "route_mode"
  | "openai_base_url"
  | "anthropic_base_url"
  | "is_code_agent"
>;

/** 当前客户端协议是否由 route_mode 转发到另一协议。 */
export function isRoutedProtocol(
  routeMode: RouteMode,
  clientProtocol: Protocol
): boolean {
  if (routeMode === "anthropic-to-openai") {
    return clientProtocol === "anthropic";
  }
  if (routeMode === "openai-to-anthropic") {
    return clientProtocol === "openai" || clientProtocol === "openai-responses";
  }
  return false;
}

/**
 * 固定路由矩阵：A→O 始终落到 Chat Completions；O→A 的 Chat 与 Responses
 * 都落到 Anthropic Messages。未命中的协议保持同协议直连。
 */
export function resolveRoute(
  llm: RoutableLlm,
  clientProtocol: Protocol
): { plan: RoutePlan } | { error: string } {
  let backendProtocol: Protocol = clientProtocol;
  if (llm.route_mode === "anthropic-to-openai" && clientProtocol === "anthropic") {
    backendProtocol = "openai";
  } else if (
    llm.route_mode === "openai-to-anthropic" &&
    (clientProtocol === "openai" || clientProtocol === "openai-responses")
  ) {
    backendProtocol = "anthropic";
  }

  const routed = backendProtocol !== clientProtocol;
  if (backendProtocol === "anthropic" && llm.is_code_agent === 1) {
    return {
      error: routed
        ? "CodeAgent 没有 Anthropic 后端，无法使用 O→A 路由"
        : "CodeAgent 不支持 Anthropic 协议；可选择 A→O 路由",
    };
  }

  const baseUrl =
    backendProtocol === "anthropic"
      ? llm.anthropic_base_url.trim()
      : llm.openai_base_url.trim();
  if (!baseUrl) {
    const target = backendProtocol === "anthropic" ? "Anthropic" : "OpenAI";
    return { error: `LLM「${llm.name}」没有配置路由目标 ${target} Base URL` };
  }

  return {
    plan: { clientProtocol, backendProtocol, baseUrl, routed },
  };
}
