import { handleRelay } from "@/lib/relay-handler";

/**
 * OpenAI Responses 中转入口：http://host/v1/responses
 *
 * 与 /v1/chat/completions 同属 OpenAI 协议（Bearer 鉴权、同 Base URL），
 * 同格式透传到上游 v1/responses，支持 SSE 流式。
 * 客户端把 base url 设为 http://host，model 填目标 LLM 的别名。
 */
export async function POST(req: Request) {
  return handleRelay(req, "v1/responses");
}

// 动态代理路由，禁止静态化
export const dynamic = "force-dynamic";
