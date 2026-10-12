import * as vscode from "vscode";
import { OllamaBackend } from "./backends/ollama";
import { cfg, createApiBackend } from "./config";
import type { Backend, ChatRequest } from "./core/types";
import { inspectLocal } from "./localGuard";

/** Backend para las herramientas con IA según el modo; undefined (con aviso) si no se puede. */
export async function chatBackend(secrets: vscode.SecretStorage): Promise<Backend | undefined> {
  if (cfg().mode === "api") {
    try {
      return await createApiBackend(secrets);
    } catch (err) {
      void vscode.window.showErrorMessage(`Conexiones: ${(err as Error).message}`);
      return undefined;
    }
  }
  const local = await inspectLocal();
  if (!local.reachable) {
    void vscode.window.showErrorMessage(`Conexiones: Ollama no responde en ${local.url}. Inícialo o cambia al modo API.`);
    return undefined;
  }
  if (!local.model) {
    void vscode.window.showWarningMessage(`Conexiones: ${local.notice?.text ?? "no hay un modelo de chat disponible."}`);
    return undefined;
  }
  return new OllamaBackend(local.url, local.model);
}

type Attempt = { ok: string } | { cancelled: true } | { error: string };

/** Un intento: notificación cancelable y límite de tiempo. */
function attempt(backend: Backend, req: ChatRequest, what: string, log: vscode.LogOutputChannel): Thenable<Attempt> {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Conexiones: ${what} con ${backend.label}…`, cancellable: true },
    async (_progress, token): Promise<Attempt> => {
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort());
      const timer = setTimeout(() => abort.abort(), 120_000);
      let out = "";
      try {
        for await (const piece of backend.chat(req, abort.signal)) out += piece;
        return { ok: out };
      } catch (err) {
        if (token.isCancellationRequested) return { cancelled: true };
        const error = abort.signal.aborted ? "el modelo tardó demasiado en responder." : (err as Error).message;
        log.error(`${what}: ${error}`);
        return { error };
      } finally {
        clearTimeout(timer);
      }
    },
  );
}

/** Petición de chat con notificación cancelable y límite de tiempo. Si falla, ofrece «Reintentar». undefined si se canceló o falló. */
export async function runChat(backend: Backend, req: ChatRequest, what: string, log: vscode.LogOutputChannel): Promise<string | undefined> {
  for (;;) {
    const r = await attempt(backend, req, what, log);
    if ("ok" in r) return r.ok;
    if ("cancelled" in r) return undefined;
    const pick = await vscode.window.showErrorMessage(`Conexiones: error ${what}: ${r.error}`, "Reintentar");
    if (pick !== "Reintentar") return undefined;
  }
}

/** Llamada breve y silenciosa (sin notificación ni «Reintentar») para pasos auxiliares; undefined si falla o tarda. */
export async function quickChat(backend: Backend, req: ChatRequest, ms = 30_000): Promise<string | undefined> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    let out = "";
    for await (const piece of backend.chat(req, abort.signal)) out += piece;
    return out;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
