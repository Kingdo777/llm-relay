import { listLlms } from "@/lib/db";

export async function GET() {
  const models = listLlms()
    .filter((model) => model.enabled === 1)
    .map((model) => ({
      id: model.id,
      name: model.name,
      alias: model.alias,
      model_name: model.model_name,
      openai_supported: model.openai_supported,
      anthropic_supported: model.anthropic_supported,
      openai_responses_supported: model.openai_responses_supported,
      protocols_tested_at: model.protocols_tested_at,
    }));
  return Response.json({ ok: true, models });
}
