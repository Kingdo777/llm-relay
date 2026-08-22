import { handleRelay } from "@/lib/relay-handler";

/**
 * OpenAI Chat Completions 兼容入口：http://host/chat/completions
 *
 * 部分客户端会直接请求 /chat/completions（不拼 /v1）。此入口与
 * /v1/chat/completions 行为一致，仍按 openai 协议透传到上游。
 */
export async function POST(req: Request) {
  return handleRelay(req, "chat/completions");
}

// 动态代理路由，禁止静态化
export const dynamic = "force-dynamic";
