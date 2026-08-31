import OpenAI from "openai";

let client: OpenAI | null = null;

export function isLlmConfigured(): boolean {
  return Boolean(process.env.OPENAI_API_KEY);
}

export function getLlmClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return client;
}

export const LLM_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

/**
 * Calls the LLM in strict JSON mode and returns the parsed object. The LLM's
 * only job anywhere in this system is turning unstructured text into
 * structured *explanation* (see aiUnderstanding.ts) — it never decides
 * whether a trade is issued. That decision is made entirely by the
 * deterministic scoring/validation engine in src/lib/scoring.
 */
export async function callJsonLlm<T>(params: {
  system: string;
  user: string;
  temperature?: number;
}): Promise<T> {
  const openai = getLlmClient();
  const completion = await openai.chat.completions.create({
    model: LLM_MODEL,
    temperature: params.temperature ?? 0.2,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: params.system },
      { role: "user", content: params.user },
    ],
  });
  const content = completion.choices[0]?.message?.content;
  if (!content) throw new Error("LLM returned empty content");
  return JSON.parse(content) as T;
}
