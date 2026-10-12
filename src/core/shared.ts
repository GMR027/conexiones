/** Modelos «base» (autocompletado, FIM): no siguen instrucciones. */
export function isCompletionOnly(name: string): boolean {
  return /-base\b|starcoder|-code\b|:code\b/i.test(name);
}

/** Un modelo que sirve para chatear (ni base ni de embeddings). */
export const isChatModel = (name: string): boolean => !isCompletionOnly(name) && !/embed/i.test(name);

/**
 * Elige un modelo instruct instalado: primero la variante instruct del modelo de
 * autocompletado, luego cualquiera de código, luego cualquiera. undefined si solo hay base.
 */
export function pickChatModel(installed: string[], completionModel: string): string | undefined {
  const sibling = completionModel.replace(/-base\b/, "");
  if (sibling !== completionModel && installed.includes(sibling)) return sibling;
  const instruct = installed.filter(isChatModel);
  return instruct.find((m) => /coder|code/i.test(m)) ?? instruct[0];
}

/** Lo que se sabe de la extensión GhostCode (undefined si no está instalada). */
export interface GhostInfo {
  /** «local», «api» u «off». */
  mode: string;
  /** Modelo de autocompletado (base). */
  model: string;
  /** Modelo de chat elegido por el usuario en GhostCode (vacío = automático). */
  chatModel: string;
}

export interface ResolveInput {
  /** Modelos cargados ahora en memoria (`/api/ps`); undefined si Ollama no responde. */
  loaded: string[] | undefined;
  /** Modelos descargados; undefined si Ollama no responde. */
  installed: string[] | undefined;
  ghost: GhostInfo | undefined;
  /** Modelo de chat de Conexiones (vacío = automático). */
  ownChatModel: string;
}

export interface Notice {
  level: "info" | "warn";
  text: string;
}

export interface LocalResolution {
  /** Modelo que usará Conexiones; undefined si no hay ninguno adecuado. */
  model?: string;
  /** true si ya está en memoria: usarlo no carga nada nuevo. */
  alreadyLoaded: boolean;
  notice?: Notice;
}

/**
 * Decide qué modelo local usar para NO cargar dos modelos a la vez.
 * Prioridad: instruct ya cargado → modelo de chat de GhostCode → el que GhostCode elegiría
 * por su cuenta → el de Conexiones → cualquier instruct instalado.
 */
export function resolveLocalModel(i: ResolveInput): LocalResolution {
  if (!i.installed || !i.loaded) return { alreadyLoaded: false };
  const { loaded, installed, ghost } = i;
  const has = (m: string) => !!m && installed.includes(m);

  const chatLoaded = loaded.find(isChatModel);
  const baseLoaded = loaded.find(isCompletionOnly);
  const ghostLocal = ghost?.mode === "local";
  const owner = ghostLocal ? "GhostCode" : "Ollama";

  const model =
    chatLoaded ??
    (ghost && has(ghost.chatModel) ? ghost.chatModel : undefined) ??
    (ghost ? pickChatModel(installed, ghost.model) : undefined) ??
    (has(i.ownChatModel) ? i.ownChatModel : undefined) ??
    pickChatModel(installed, "");

  const alreadyLoaded = !!model && loaded.includes(model);
  let notice: Notice | undefined;

  if (chatLoaded) {
    notice = {
      level: "info",
      text: `${owner} ya está cargando un modelo (${chatLoaded}). Conexiones usará el mismo para no cargar dos.`,
    };
  } else if (baseLoaded && model) {
    notice = {
      level: "warn",
      text: `${owner} ya está cargando el modelo de autocompletado (${baseLoaded}), que no sigue instrucciones. Conexiones usará ${model}, así que Ollama tendrá dos modelos en memoria. Para evitarlo, usa el modo API.`,
    };
  } else if (baseLoaded) {
    notice = {
      level: "warn",
      text: `${owner} ya está cargando el modelo de autocompletado (${baseLoaded}), que no sigue instrucciones, y no tienes ningún modelo de chat descargado. Usa el modo API o descarga uno (p. ej. qwen2.5-coder:1.5b).`,
    };
  } else if (!model) {
    notice = { level: "warn", text: "No hay ningún modelo de chat descargado en Ollama (p. ej. qwen2.5-coder:1.5b). Descárgalo o usa el modo API." };
  } else if (ghostLocal && loaded.length === 0) {
    notice = { level: "info", text: `GhostCode aún no ha cargado ningún modelo. Conexiones usará ${model}; si el modelo de GhostCode es otro, Ollama podría tener dos.` };
  }
  return { model, alreadyLoaded, notice };
}
