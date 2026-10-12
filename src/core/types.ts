/** Petición de texto libre (system + user). */
export interface ChatRequest {
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
}

export interface Backend {
  /** Identificador estable. */
  readonly id: string;
  /** Texto corto para mostrar (p. ej. «Local · qwen2.5-coder:1.5b»). */
  readonly label: string;
  /** Respuesta de chat en streaming. */
  chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<string>;
}

/** Error con un mensaje pensado para mostrarse al usuario. */
export class BackendError extends Error {
  constructor(
    message: string,
    readonly kind: "auth" | "connection" | "model" | "rate-limit" | "other" = "other",
  ) {
    super(message);
  }
}
