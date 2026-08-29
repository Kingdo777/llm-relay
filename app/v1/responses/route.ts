import { handleRelay } from "@/lib/relay-handler";

/**
 * OpenAI Responses 中转入口：http://host/v1/responses
 *
 * 默认同格式透传到上游 v1/responses；启用 O→A 时转换并路由到
 * Anthropic Messages，响应再转换回 Responses 格式（支持 SSE）。
 * 客户端把 base url 设为 http://host，model 填目标 LLM 的别名。
 */
export async function POST(req: Request) {
  return handleRelay(req, "v1/responses");
}

// 动态代理路由，禁止静态化
export const dynamic = "force-dynamic";
