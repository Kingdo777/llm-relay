import { handleRelay } from "@/lib/relay-handler";

/**
 * Anthropic 兼容入口：http://host/messages
 *
 * 部分客户端会直接请求 /messages（不拼 /v1）。此入口与
 * /v1/messages 行为一致，仍按 anthropic 协议透传到上游。
 */
export async function POST(req: Request) {
  return handleRelay(req, "messages");
}

// 动态代理路由，禁止静态化
export const dynamic = "force-dynamic";
