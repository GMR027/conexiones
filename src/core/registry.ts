/** Pestañas del panel. */
export type TabId = "assistant" | "connections" | "library" | "resources" | "status" | "settings";

export const TABS: readonly { id: TabId; label: string; subtitle: string }[] = [
  { id: "assistant", label: "Asistente", subtitle: "Pregunta en tus palabras; responde con lo que hay en tus conexiones" },
  { id: "connections", label: "Conexiones", subtitle: "Webs de ayuda, librerías, paquetes, iconos, fuentes, imágenes y servidores MCP" },
  { id: "library", label: "Biblioteca", subtitle: "Lo que ya está guardado en tu equipo, para usar sin conexión" },
  { id: "resources", label: "Recursos", subtitle: "Iconos, fuentes e imágenes listos para copiar o guardar en tu proyecto" },
  { id: "status", label: "Estado", subtitle: "Salud de cada conexión y del almacenamiento" },
  { id: "settings", label: "Ajustes", subtitle: "Seguridad, sincronización, almacenamiento y búsqueda" },
];

/** Nombre del idioma para pedírselo a la IA. */
const LANG_NAMES: Record<string, string> = { es: "Spanish", en: "English", pt: "Portuguese", fr: "French", de: "German", it: "Italian" };

/** Idioma de las respuestas: el ajuste, luego el del editor y luego el del sistema (por defecto, inglés). */
export function resolveLanguage(setting: string, editor: string, env: Record<string, string | undefined>): string {
  if (setting !== "auto") return setting;
  const pick = (s?: string) => {
    const code = s?.toLowerCase().slice(0, 2) ?? "";
    return code in LANG_NAMES ? code : undefined;
  };
  return pick(editor) ?? pick(env.LC_ALL ?? env.LC_MESSAGES ?? env.LANG) ?? "en";
}

export const languageName = (code: string): string => LANG_NAMES[code] ?? "English";

/** Quita la cerca ```markdown que algunos modelos ponen alrededor de toda la respuesta. */
export function cleanReply(raw: string): string {
  const text = raw.trim();
  const open = /^```(?:markdown|md)?\n/.exec(text);
  if (!open) return text;
  const inner = text.slice(open[0].length);
  const fences = (inner.match(/^```/gm) ?? []).length;
  return (fences % 2 === 1 ? inner.replace(/\n```\s*$/, "") : inner).trim();
}
