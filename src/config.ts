import * as vscode from "vscode";
import { ANTHROPIC_DEFAULT_MODEL, AnthropicBackend } from "./backends/anthropic";
import { CODESTRAL_DEFAULT_MODEL, CODESTRAL_DEFAULT_URL, CodestralBackend } from "./backends/codestral";
import { OPENAI_DEFAULT_URL, OpenAICompatBackend } from "./backends/openaiCompat";
import { OpencodeBackend } from "./backends/opencode";
import { BackendError, type Backend } from "./core/types";
import { parseHostList, type UrlPolicy } from "./core/urlPolicy";

export type Mode = "local" | "api";
export type ApiProvider = "anthropic" | "codestral" | "openai-compatible" | "opencode";

export const PROVIDER_LABELS: Record<ApiProvider, string> = {
  anthropic: "Anthropic Claude",
  codestral: "Mistral Codestral",
  "openai-compatible": "Compatible con OpenAI",
  opencode: "OpenCode",
};

const ENV_KEYS: Record<ApiProvider, string[]> = {
  anthropic: ["ANTHROPIC_API_KEY"],
  codestral: ["CODESTRAL_API_KEY", "MISTRAL_API_KEY"],
  "openai-compatible": ["OPENAI_API_KEY"],
  opencode: [],
};

/** OpenCode guarda sus propias credenciales (`opencode auth login`): la extensión no pide API key. */
export const usesOwnCredentials = (p: ApiProvider) => p === "opencode";

export function cfg() {
  const c = vscode.workspace.getConfiguration("conexiones");
  return {
    mode: c.get<Mode>("mode", "local"),
    /** Vacío = la de GhostCode si está instalado, o http://localhost:11434. */
    localUrl: c.get<string>("local.url", ""),
    localChatModel: c.get<string>("local.chatModel", ""),
    language: c.get<string>("language", "auto"),
    apiProvider: c.get<ApiProvider>("api.provider", "anthropic"),
    apiModel: c.get<string>("api.model", ""),
    apiBaseUrl: c.get<string>("api.baseUrl", ""),
  };
}

/** Ajustes de seguridad, sincronización, almacenamiento y búsqueda. */
export function settings() {
  const c = vscode.workspace.getConfiguration("conexiones");
  const n = (k: string, d: number, min: number, max: number) => Math.min(max, Math.max(min, Number(c.get<number>(k, d)) || d));
  return {
    allowHttp: c.get<boolean>("security.allowHttp", false),
    allowPrivate: c.get<boolean>("security.allowPrivateNetwork", false),
    blockedDomains: parseHostList((c.get<string[]>("security.blockedDomains", []) ?? []).join("\n")),
    ttlHours: n("sync.ttlHours", 24, 1, 720),
    maxPages: n("sync.maxPages", 150, 5, 1000),
    delayMs: n("sync.delayMs", 700, 200, 10_000),
    maxMb: n("storage.maxMb", 200, 20, 5000),
    embeddings: c.get<boolean>("search.embeddings", false),
    embeddingModel: c.get<string>("search.embeddingModel", ""),
    imagesFolder: c.get<string>("images.folder", "assets/images"),
    shareEnabled: c.get<boolean>("share.enabled", true),
    triconnectEnabled: c.get<boolean>("triconnect.enabled", false),
  };
}

/** La política de direcciones que decide el usuario (los ajustes de seguridad no se pueden cambiar desde un proyecto). */
export function urlPolicy(): UrlPolicy {
  const s = settings();
  return { allowHttp: s.allowHttp, allowPrivate: s.allowPrivate, blockedHosts: s.blockedDomains };
}

export async function update(key: string, value: unknown): Promise<void> {
  await vscode.workspace.getConfiguration("conexiones").update(key, value, vscode.ConfigurationTarget.Global);
}

const secretName = (p: ApiProvider) => `conexiones.apiKey.${p}`;

export async function getApiKey(secrets: vscode.SecretStorage, p: ApiProvider): Promise<string | undefined> {
  const stored = await secrets.get(secretName(p));
  if (stored) return stored;
  for (const env of ENV_KEYS[p]) if (process.env[env]) return process.env[env];
  return undefined;
}

export const setApiKey = (s: vscode.SecretStorage, p: ApiProvider, key: string) => s.store(secretName(p), key);
export const deleteApiKey = (s: vscode.SecretStorage, p: ApiProvider) => s.delete(secretName(p));

export function defaultApiModel(p: ApiProvider): string {
  if (p === "anthropic") return ANTHROPIC_DEFAULT_MODEL;
  if (p === "codestral") return CODESTRAL_DEFAULT_MODEL;
  return "";
}

/** Backend del modo API. (El local lo crea `localGuard.ts`, que decide qué modelo usar.) */
export async function createApiBackend(secrets: vscode.SecretStorage): Promise<Backend> {
  const c = cfg();
  const key = await getApiKey(secrets, c.apiProvider);
  const model = c.apiModel || defaultApiModel(c.apiProvider);
  switch (c.apiProvider) {
    case "anthropic":
      return new AnthropicBackend(key, model, c.apiBaseUrl || undefined);
    case "codestral":
      if (!key) throw new BackendError("Codestral: falta la API key. Usa «Conexiones: Guardar API key».", "auth");
      return new CodestralBackend(key, model, c.apiBaseUrl || CODESTRAL_DEFAULT_URL);
    case "openai-compatible":
      return new OpenAICompatBackend(key, model, c.apiBaseUrl || OPENAI_DEFAULT_URL);
    case "opencode":
      return new OpencodeBackend(model);
  }
}
