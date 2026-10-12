import { BackendError, type Backend, type ChatRequest } from "../core/types";
import { joinUrl, postJson, readSse } from "./http";

export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1";

/** Modo API genérico compatible con OpenAI: OpenAI, DeepSeek, OpenRouter, Groq, LM Studio, vLLM… */
export class OpenAICompatBackend implements Backend {
  readonly id: string;
  readonly label: string;

  constructor(private readonly apiKey: string | undefined, private readonly model: string, private readonly baseUrl: string) {
    this.id = `openai:${baseUrl}:${model}`;
    this.label = `API · ${model}`;
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    if (!this.model) throw new BackendError("Falta el modelo. Ejecuta «Conexiones: Configurar proveedor API».", "model");
    const res = await postJson(
      joinUrl(this.baseUrl, "/chat/completions"),
      {
        model: this.model,
        messages: [
          { role: "system", content: req.system },
          { role: "user", content: req.user },
        ],
        // OpenAI exige max_completion_tokens; el resto de servidores compatibles usa max_tokens.
        [/api\.openai\.com/.test(this.baseUrl) ? "max_completion_tokens" : "max_tokens"]: req.maxTokens,
        stream: true,
      },
      this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {},
      signal,
      "API",
    );
    for await (const ev of readSse(res)) {
      const piece = ev?.choices?.[0]?.delta?.content;
      if (typeof piece === "string" && piece) yield piece;
    }
  }
}
