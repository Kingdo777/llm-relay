import { listLlms } from "@/lib/db";
import { createModelsResponse } from "@/lib/model-list";

/**
 * GET /v1/models —— 返回已启用的 LLM 别名作为模型列表。
 *
 * OpenAI 与 Anthropic 都使用该路径。根据 SDK 发送的协议请求头
 * 返回对应的 Models API 结构；无 Anthropic 请求头时默认为 OpenAI。
 */
export async function GET(request: Request) {
  return createModelsResponse(request, listLlms());
}

export const dynamic = "force-dynamic";
