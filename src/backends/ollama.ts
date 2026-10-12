import { BackendError, type Backend, type ChatRequest } from "../core/types";
import { joinUrl, postJson, readLines } from "./http";

/**
 * IMPORTANTE: mismos valores que GhostCode. Si cambian `num_ctx` o `keep_alive`,
 * Ollama descarga el modelo y lo vuelve a cargar, que es justo lo que se quiere evitar.
 */
export const NUM_CTX = 8192;
export const KEEP_ALIVE = "30m";

/** Opciones para exprimir el equipo (Modo Kraken). Cambiar `num_ctx` hace que Ollama recargue el modelo una vez. */
export interface OllamaTuning {
  numCtx: number;
  /** Capas en la GPU; un número alto = todas las que quepan. */
  numGpu: number;
  numThread: number;
  keepAlive: string;
}

export interface OllamaModel {
  name: string;
  size: number;
}

/** Modo LOCAL: Ollama. */
export class OllamaBackend implements Backend {
  readonly id: string;
  readonly label: string;

  constructor(private readonly baseUrl: string, private readonly model: string, private readonly tuning?: OllamaTuning) {
    this.id = `ollama:${model}`;
    this.label = `Local · ${model}`;
  }

  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    let res: Response;
    try {
      res = await postJson(
        joinUrl(this.baseUrl, "/api/chat"),
        {
          model: this.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          stream: true,
          keep_alive: this.tuning?.keepAlive ?? KEEP_ALIVE,
          options: this.tuning
            ? { temperature: req.temperature, num_predict: req.maxTokens, num_ctx: this.tuning.numCtx, num_gpu: this.tuning.numGpu, num_thread: this.tuning.numThread }
            : { temperature: req.temperature, num_predict: req.maxTokens, num_ctx: NUM_CTX },
        },
        {},
        signal,
        "Ollama",
      );
    } catch (err) {
      if (err instanceof BackendError && err.kind === "model") {
        throw new BackendError(`Ollama no tiene el modelo "${this.model}". Ejecuta: ollama pull ${this.model}`, "model");
      }
      if (err instanceof BackendError && err.kind === "connection") {
        throw new BackendError(`Ollama no responde en ${this.baseUrl}. ¿Está corriendo? (systemctl start ollama / ollama serve)`, "connection");
      }
      throw err;
    }
    for await (const line of readLines(res)) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string };
      if (msg.error) throw new BackendError(`Ollama: ${msg.error}`);
      if (msg.message?.content) yield msg.message.content;
      if (msg.done) return;
    }
  }

  /** Modelos descargados. */
  static async listModels(baseUrl: string): Promise<OllamaModel[]> {
    const res = await fetch(joinUrl(baseUrl, "/api/tags"), { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: OllamaModel[] };
    return data.models ?? [];
  }

  /** Modelos que ahora mismo están cargados en memoria (cualquier programa que use ese Ollama). */
  static async loadedModels(baseUrl: string): Promise<string[]> {
    const res = await fetch(joinUrl(baseUrl, "/api/ps"), { signal: AbortSignal.timeout(3000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { models?: { name: string }[] };
    return (data.models ?? []).map((m) => m.name);
  }
}
