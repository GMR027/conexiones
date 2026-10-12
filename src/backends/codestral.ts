import type { Backend, ChatRequest } from "../core/types";
import { joinUrl, postJson, readSse } from "./http";

export const CODESTRAL_DEFAULT_URL = "https://codestral.mistral.ai/v1";
export const CODESTRAL_DEFAULT_MODEL = "codestral-latest";

/** Modo API: Mistral Codestral. */
export class CodestralBackend implements Backend {
  readonly id: string;
  readonly label: string;

  constructor(private readonly apiKey: string, private readonly model: string, private readonly baseUrl: string) {
    this.id = `codestral:${model}`;
    this.label = `Codestral · ${model}`;
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    const res = await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      {
        model: this.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
      },
      { authorization: `Bearer ${this.apiKey}` },
      signal,
      "Codestral",
    );
    for await (const ev of readSse(res)) {
      const piece = ev?.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece) yield piece;
    }
  }
}
