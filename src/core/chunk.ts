import { createHash } from "node:crypto";
import type { Block } from "./html";
import { injectionFindings } from "./safety";

/** Trozo de una página: lo que se busca, se guarda y se le da a la IA. */
export interface Chunk {
  id: string;
  /** Página de origen. */
  url: string;
  /** Título de la página. */
  title: string;
  /** Ruta de títulos dentro de la página («Instalación › Composer»). */
  heading: string;
  text: string;
  hasCode: boolean;
  /** Motivos por los que el contenido parece dar órdenes a la IA; si hay, no se le da a la IA. */
  flagged?: string[];
}

export const CHUNK_MAX = 1800;
const CHUNK_MIN = 350;

const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

/** Corta un texto largo por líneas sin pasar de `max` caracteres. */
function splitLong(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    const piece = line.length > max ? line.match(new RegExp(`[\\s\\S]{1,${max}}`, "g")) ?? [line] : [line];
    for (const p of piece) {
      if (cur && cur.length + p.length + 1 > max) (out.push(cur), (cur = ""));
      cur += (cur ? "\n" : "") + p;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Divide una página en trozos por títulos, sin partir bloques de código si caben. */
export function chunkPage(url: string, title: string, blocks: Block[], max = CHUNK_MAX): Chunk[] {
  const chunks: Chunk[] = [];
  const path: { level: number; text: string }[] = [];
  let heading = "";
  let buf: string[] = [];
  let size = 0;
  let hasCode = false;
  const flush = () => {
    const text = buf.join("\n\n").trim();
    if (text) {
      const flagged = injectionFindings(text);
      chunks.push({ id: hash(`${url}#${chunks.length}#${text.slice(0, 40)}`), url, title, heading, text, hasCode, ...(flagged.length ? { flagged } : {}) });
    }
    buf = [];
    size = 0;
    hasCode = false;
  };
  const add = (text: string, code = false) => {
    for (const part of splitLong(text, max)) {
      if (size && size + part.length > max) flush();
      buf.push(code ? "```\n" + part + "\n```" : part);
      size += part.length;
      hasCode ||= code;
    }
  };
  for (const b of blocks) {
    if (b.type === "h") {
      if (size >= CHUNK_MIN) flush();
      while (path.length && path[path.length - 1].level >= b.level) path.pop();
      path.push({ level: b.level, text: b.text });
      // Un título nuevo empieza trozo si el anterior ya tiene cuerpo; si no, se acumula.
      heading = path.map((p) => p.text).join(" › ");
      if (size) buf.push(`${"#".repeat(Math.min(b.level, 6))} ${b.text}`);
      continue;
    }
    if (b.type === "code") add(b.text, true);
    else add(b.type === "li" ? `- ${b.text}` : b.text);
  }
  flush();
  return chunks;
}
