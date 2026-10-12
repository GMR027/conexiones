import { stripHidden } from "../core/safety";
import type { FetchFn } from "../net/safeFetch";
import type { Library, Source } from "../store/library";

/** Lista pública y gratuita de fuentes de Google (sin clave de API). */
export const FONTS_API = "https://api.fontsource.org/v1/fonts";

/** Fuentes por página en el buscador. */
export const FONT_PAGE = 10;

export const FONT_CATEGORIES = ["sans-serif", "serif", "display", "handwriting", "monospace"] as const;

/** Fuente guardada de forma compacta. */
export interface FontRec {
  /** Identificador («open-sans»). */
  id: string;
  /** Nombre de la familia («Open Sans»). */
  f: string;
  /** Categoría. */
  c: string;
  /** Pesos disponibles. */
  w: number[];
  /** Tiene cursiva. */
  i: boolean;
  /** Es variable. */
  v: boolean;
}

export interface FontFile {
  v: 1;
  fetchedAt: number;
  fonts: FontRec[];
}

const ID_OK = /^[a-z0-9][a-z0-9-]{0,80}$/;
const FAMILY_OK = /^[\p{L}\p{N} .'&-]{1,70}$/u;

/** Reduce la lista de Fontsource a las fuentes de Google, descartando todo lo que no se reconoce. */
export function compactFonts(raw: unknown): FontRec[] {
  if (!Array.isArray(raw)) return [];
  const out: FontRec[] = [];
  for (const r of raw as any[]) {
    if (r?.type !== "google" || typeof r.id !== "string" || !ID_OK.test(r.id)) continue;
    const family = typeof r.family === "string" ? stripHidden(r.family).trim() : "";
    if (!FAMILY_OK.test(family)) continue;
    const w: number[] = (Array.isArray(r.weights) ? (r.weights as unknown[]) : []).filter((n): n is number => typeof n === "number" && n >= 100 && n <= 900 && n % 100 === 0);
    if (!w.length) continue;
    out.push({ id: r.id, f: family, c: typeof r.category === "string" ? r.category.replace(/[^a-z-]/g, "").slice(0, 20) : "other", w: [...new Set(w)].sort((a, b) => a - b), i: Array.isArray(r.styles) && r.styles.includes("italic"), v: r.variable === true });
  }
  return out;
}

export async function syncFonts(lib: Library, source: Source, fetch: FetchFn): Promise<number> {
  const r = await fetch(FONTS_API, { accept: ["application/json", "text/plain"], maxBytes: 8 * 1024 * 1024, timeoutMs: 60_000 });
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    throw new Error("La lista de fuentes llegó dañada.");
  }
  const fonts = compactFonts(raw);
  if (!fonts.length) throw new Error("No encontré fuentes en la lista descargada.");
  await lib.writeFile(source.id, "fonts.json", { v: 1, fetchedAt: Date.now(), fonts } satisfies FontFile);
  await lib.update(source.id, { lastSync: Date.now(), status: "ok", error: undefined, pages: 0, chunks: fonts.length });
  return fonts.length;
}

/** Busca por nombre (lo que empieza igual sube) y filtra por categoría. */
export function searchFonts(fonts: readonly FontRec[], query: string, category?: string, limit = 40): FontRec[] {
  const q = query.trim().toLowerCase();
  const words = q.split(/\s+/).filter(Boolean);
  const scored: { f: FontRec; score: number }[] = [];
  for (const f of fonts) {
    if (category && f.c !== category) continue;
    const name = f.f.toLowerCase();
    let score = 0;
    if (!words.length) score = 1;
    else if (name === q) score = 100;
    else if (name.startsWith(q)) score = 60;
    else if (name.includes(q)) score = 40;
    else if (words.every((w) => name.includes(w))) score = 20;
    if (score) scored.push({ f, score });
  }
  return scored.sort((a, b) => b.score - a.score || a.f.f.localeCompare(b.f.f)).slice(0, limit).map((s) => s.f);
}

/** Pesos elegidos válidos para la fuente; sin elección, 400 y 700 si existen (o el primero). */
export function pickWeights(font: FontRec, wanted: readonly unknown[] = []): number[] {
  const valid = [...new Set(wanted.filter((n): n is number => typeof n === "number" && font.w.includes(n)))].sort((a, b) => a - b);
  if (valid.length) return valid;
  const def = [400, 700].filter((n) => font.w.includes(n));
  return def.length ? def : [font.w[0]];
}

/** Dirección de la hoja de estilos de Google Fonts. */
export function googleCssUrl(font: FontRec, weights: number[], italic: boolean): string {
  const fam = font.f.replace(/ /g, "+");
  const ws = pickWeights(font, weights);
  const axis = italic && font.i ? `ital,wght@${[0, 1].flatMap((it) => ws.map((w) => `${it},${w}`)).join(";")}` : `wght@${ws.join(";")}`;
  return `https://fonts.googleapis.com/css2?family=${fam}:${axis}&display=swap`;
}

export const cssFamily = (font: FontRec): string => `font-family: '${font.f}', ${font.c === "other" ? "sans-serif" : font.c};`;

export type FontWhat = "link" | "import" | "css" | "npm";

/** Texto listo para pegar. Las etiquetas del HTML son las que da Google Fonts. */
export function fontSnippet(font: FontRec, what: FontWhat, weights: number[], italic: boolean): string {
  const url = googleCssUrl(font, weights, italic);
  switch (what) {
    case "link":
      return `<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>\n<link href="${url}" rel="stylesheet">`;
    case "import":
      return `@import url('${url}');`;
    case "css":
      return cssFamily(font);
    case "npm": {
      const ws = pickWeights(font, weights);
      return `npm install @fontsource/${font.id}\n\n${ws.map((w) => `import "@fontsource/${font.id}/${w}.css";`).join("\n")}`;
    }
  }
}
