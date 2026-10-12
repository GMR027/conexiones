import * as vscode from "vscode";
import { OllamaBackend } from "./backends/ollama";
import { cfg } from "./config";
import { resolveLocalModel, type GhostInfo, type LocalResolution } from "./core/shared";

export const GHOSTCODE_ID = "edgar.ghostcode";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface LocalStatus extends LocalResolution {
  url: string;
  reachable: boolean;
  ghostInstalled: boolean;
  /** Modelos cargados ahora en Ollama. */
  loaded: string[];
}

/** Lee la configuración de GhostCode (si está instalada) para compartir su Ollama y su modelo. */
export function ghostInfo(): (GhostInfo & { url: string }) | undefined {
  if (!vscode.extensions.getExtension(GHOSTCODE_ID)) return undefined;
  const c = vscode.workspace.getConfiguration("ghostcode");
  return {
    mode: c.get<string>("mode", "local"),
    model: c.get<string>("local.model", ""),
    chatModel: c.get<string>("local.chatModel", ""),
    url: c.get<string>("local.url", DEFAULT_OLLAMA_URL),
  };
}

/**
 * Mira qué hay cargado en Ollama y decide qué modelo usar para no cargar uno
 * segundo mientras GhostCode (u otro programa) ya tiene uno en memoria.
 */
export async function inspectLocal(): Promise<LocalStatus> {
  const ghost = ghostInfo();
  const c = cfg();
  const url = c.localUrl || ghost?.url || DEFAULT_OLLAMA_URL;
  try {
    const [installed, loaded] = await Promise.all([
      OllamaBackend.listModels(url).then((m) => m.map((x) => x.name)),
      OllamaBackend.loadedModels(url),
    ]);
    const res = resolveLocalModel({ loaded, installed, ghost, ownChatModel: c.localChatModel });
    return { ...res, url, reachable: true, ghostInstalled: !!ghost, loaded };
  } catch {
    return { url, reachable: false, ghostInstalled: !!ghost, loaded: [], alreadyLoaded: false };
  }
}
