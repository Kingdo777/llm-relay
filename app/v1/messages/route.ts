import { handleRelay } from "@/lib/relay-handler";

/**
 * Anthropic 中转入口：http://host/v1/messages
 * 客户端把 base url 设为 http://host，model 填目标 LLM 的别名。
 */
export async function POST(req: Request) {
  return handleRelay(req, "v1/messages");
}

// 动态代理路由，禁止静态化
export const dynamic = "force-dynamic";
