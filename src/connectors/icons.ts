import { stripHidden } from "../core/safety";
import type { FetchFn } from "../net/safeFetch";
import type { Library, Source } from "../store/library";

export const FA_METADATA = "https://raw.githubusercontent.com/FortAwesome/Font-Awesome/6.x/metadata/icons.json";
export const FA_STYLES = ["solid", "regular", "brands"] as const;
export type FaStyle = (typeof FA_STYLES)[number];

/** Icono guardado de forma compacta. */
export interface IconRec {
  /** Nombre («envelope»). */
  n: string;
  /** Etiqueta legible. */
  l: string;
  /** Términos de búsqueda. */
  t: string[];
  /** Estilos disponibles: viewBox y trazado. */
  s: Partial<Record<FaStyle, { v: [number, number, number, number]; d: string }>>;
}

export interface IconFile {
  v: 1;
  fetchedAt: number;
  icons: IconRec[];
}

const PATH_OK = /^[0-9a-zA-Z\s.,\-+]+$/;
const NAME_OK = /^[a-z0-9-]+$/;

/** Reduce el metadata de Font Awesome (gratis) a lo necesario, descartando todo lo que no se reconoce. */
export function compactFontAwesome(raw: unknown): IconRec[] {
  if (!raw || typeof raw !== "object") return [];
  const out: IconRec[] = [];
  for (const [name, v] of Object.entries(raw as Record<string, any>)) {
    if (!NAME_OK.test(name) || !v?.svg || typeof v.svg !== "object") continue;
    const s: IconRec["s"] = {};
    for (const style of FA_STYLES) {
      const e = v.svg[style];
      const vb = e?.viewBox;
      if (typeof e?.path !== "string" || !PATH_OK.test(e.path) || e.path.length > 8000) continue;
      if (!Array.isArray(vb) || vb.length !== 4 || !vb.every((n: unknown) => typeof n === "number" && Number.isFinite(n))) continue;
      s[style] = { v: vb as [number, number, number, number], d: e.path };
    }
    if (!Object.keys(s).length) continue;
    const terms: string[] = Array.isArray(v.search?.terms) ? v.search.terms.filter((t: unknown) => typeof t === "string").map((t: string) => stripHidden(t).slice(0, 40)).slice(0, 20) : [];
    out.push({ n: name, l: stripHidden(typeof v.label === "string" ? v.label : name).slice(0, 60), t: terms, s });
  }
  return out;
}

export async function syncFontAwesome(lib: Library, source: Source, fetch: FetchFn): Promise<number> {
  const r = await fetch(FA_METADATA, { accept: ["text/plain", "application/json"], maxBytes: 12 * 1024 * 1024, timeoutMs: 60_000 });
  let raw: unknown;
  try {
    raw = JSON.parse(r.text);
  } catch {
    throw new Error("La lista de iconos llegó dañada.");
  }
  const icons = compactFontAwesome(raw);
  if (!icons.length) throw new Error("No encontré iconos en la lista descargada.");
  await lib.writeFile(source.id, "icons.json", { v: 1, fetchedAt: Date.now(), icons } satisfies IconFile);
  await lib.update(source.id, { lastSync: Date.now(), status: "ok", error: undefined, pages: 0, chunks: icons.length });
  return icons.length;
}

export interface IconHit {
  name: string;
  label: string;
  styles: FaStyle[];
}

/** Busca por nombre, etiqueta y términos; el nombre exacto o que empieza igual sube. */
export function searchIcons(icons: readonly IconRec[], query: string, style?: FaStyle, limit = 60): IconHit[] {
  const q = query.trim().toLowerCase().replace(/\s+/g, "-");
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scored: { i: IconRec; score: number }[] = [];
  for (const i of icons) {
    if (style && !i.s[style]) continue;
    let score = 0;
    if (!q) score = 1;
    else {
      if (i.n === q) score += 100;
      else if (i.n.startsWith(q)) score += 50;
      else if (i.n.includes(q)) score += 30;
      for (const w of words) {
        if (i.t.some((t) => t.toLowerCase() === w)) score += 20;
        else if (i.t.some((t) => t.toLowerCase().includes(w))) score += 6;
        if (i.l.toLowerCase().includes(w)) score += 8;
        if (i.n.includes(w)) score += 4;
      }
    }
    if (score) scored.push({ i, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || a.i.n.localeCompare(b.i.n))
    .slice(0, limit)
    .map(({ i }) => ({ name: i.n, label: i.l, styles: FA_STYLES.filter((s) => i.s[s]) }));
}

export const faClass = (name: string, style: FaStyle): string => `fa-${style} fa-${name}`;
export const faHtml = (name: string, style: FaStyle): string => `<i class="${faClass(name, style)}"></i>`;

/** SVG autónomo (no necesita Font Awesome), con el aviso de licencia que pide el autor. */
export function faSvg(icon: IconRec, style: FaStyle): string | undefined {
  const s = icon.s[style];
  if (!s) return undefined;
  return `<!--! Font Awesome Free 6 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free (Icons: CC BY 4.0) -->\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="${s.v.join(" ")}" fill="currentColor" aria-hidden="true"><path d="${s.d}"/></svg>`;
}
