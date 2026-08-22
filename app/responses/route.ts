import { handleRelay } from "@/lib/relay-handler";

/**
 * OpenAI Responses 兼容入口：http://host/responses
 *
 * 部分客户端会直接请求 /responses（不拼 /v1）。此入口与 /v1/responses
 * 行为一致，仍按 openai-responses 协议透传到上游 v1/responses。
 */
export async function POST(req: Request) {
  return handleRelay(req, "responses");
}

// 动态代理路由，禁止静态化
export const dynamic = "force-dynamic";
