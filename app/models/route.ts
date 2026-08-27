import { listLlms } from "@/lib/db";
import { createModelsResponse } from "@/lib/model-list";

/**
 * GET /models —— /v1/models 的兼容入口。
 *
 * 部分客户端会直接请求 /models（不拼 /v1）拉取模型列表。
 * 与 /v1/models 一样，根据请求头返回 OpenAI 或 Anthropic 格式。
 */
export async function GET(request: Request) {
  return createModelsResponse(request, listLlms());
}

export const dynamic = "force-dynamic";
