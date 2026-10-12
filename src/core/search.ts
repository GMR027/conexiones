import type { Chunk } from "./chunk";

const STOP = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "on", "for", "with", "is", "are", "be", "this", "that", "it", "as", "at", "by", "from", "how", "do", "i", "you", "can",
  "el", "la", "los", "las", "un", "una", "unos", "unas", "y", "o", "de", "del", "en", "con", "para", "por", "que", "es", "se", "al", "lo", "como", "mi", "tu", "su", "quiero", "puedo", "hay",
]);

/** Quita tildes y pasa a minúsculas. */
export const fold = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Reduce plurales y terminaciones comunes (inglés y español) para que «sending», «send» y «sends» coincidan. */
export function stem(w: string): string {
  if (w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return w.slice(0, -3) + "y";
  const rules: [RegExp, string][] = [
    [/(ando|iendo)$/, ""],
    [/(ing|ed)$/, ""],
    [/(aciones|acion)$/, "a"],
    [/(mente)$/, ""],
    [/(es)$/, ""],
    [/s$/, ""],
  ];
  for (const [re, rep] of rules) if (re.test(w) && w.replace(re, rep).length >= 3) return w.replace(re, rep);
  return w;
}

/** Palabras de un texto: separa camelCase, snake_case, kebab-case y rutas, sin tildes ni palabras vacías. */
export function tokenize(text: string): string[] {
  const split = text.replace(/([a-z\d])([A-Z])/g, "$1 $2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  const out: string[] = [];
  for (const raw of fold(split).split(/[^a-z0-9ñ]+/)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

/** Palabras de un identificador compuesto («phpmailer/phpmailer») y también el identificador entero. */
function withWhole(text: string): string[] {
  const tokens = tokenize(text);
  const have = new Set(tokens);
  const whole = (fold(text).match(/[a-z0-9][a-z0-9._/-]{3,}/g) ?? []).map((w) => stem(w)).filter((w) => !have.has(w));
  return [...tokens, ...whole];
}

export interface Hit {
  chunk: Chunk;
  score: number;
}

interface Doc {
  chunk: Chunk;
  tf: Map<string, number>;
  len: number;
}

/** Índice BM25 con más peso para el título y los encabezados (BM25F simplificado). Se construye en memoria. */
export class SearchIndex {
  private readonly docs: Doc[] = [];
  private readonly df = new Map<string, number>();
  private avg = 1;

  constructor(chunks: readonly Chunk[], private readonly boost: (c: Chunk) => number = () => 1) {
    for (const chunk of chunks) {
      const tf = new Map<string, number>();
      let len = 0;
      const add = (tokens: string[], weight: number) => {
        for (const t of tokens) {
          tf.set(t, (tf.get(t) ?? 0) + weight);
          len += weight;
        }
      };
      add(withWhole(chunk.text), 1);
      add(withWhole(`${chunk.title} ${chunk.heading}`), 3);
      this.docs.push({ chunk, tf, len });
      for (const t of tf.keys()) this.df.set(t, (this.df.get(t) ?? 0) + 1);
    }
    this.avg = this.docs.reduce((s, d) => s + d.len, 0) / (this.docs.length || 1) || 1;
  }

  get size(): number {
    return this.docs.length;
  }

  /** Mejores trozos para una consulta. `extra` son términos adicionales (p. ej. traducidos por la IA) con menos peso. */
  search(query: string, limit = 8, extra: string[] = []): Hit[] {
    const weights = new Map<string, number>();
    for (const t of withWhole(query)) weights.set(t, Math.max(weights.get(t) ?? 0, 1));
    for (const e of extra) for (const t of withWhole(e)) weights.set(t, Math.max(weights.get(t) ?? 0, 0.7));
    if (!weights.size) return [];
    const n = this.docs.length;
    const k1 = 1.2;
    const b = 0.75;
    const hits: Hit[] = [];
    for (const d of this.docs) {
      let score = 0;
      for (const [term, w] of weights) {
        const f = d.tf.get(term);
        if (!f) continue;
        const df = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
        score += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / this.avg)));
      }
      if (score > 0) hits.push({ chunk: d.chunk, score: score * this.boost(d.chunk) });
    }
    return hits.sort((a, c) => c.score - a.score).slice(0, limit);
  }
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Une varias listas ordenadas (reciprocal rank fusion): lo que sale bien en todas sube. */
export function fuse(lists: Chunk[][], limit: number, k = 60): Chunk[] {
  const score = new Map<string, { chunk: Chunk; s: number }>();
  for (const list of lists) {
    list.forEach((chunk, i) => {
      const e = score.get(chunk.id) ?? { chunk, s: 0 };
      e.s += 1 / (k + i + 1);
      score.set(chunk.id, e);
    });
  }
  return [...score.values()].sort((a, b) => b.s - a.s).slice(0, limit).map((e) => e.chunk);
}

/** Vector de Float32 ↔ base64 (para guardarlo compacto). */
export const packVector = (v: ArrayLike<number>): string => Buffer.from(new Float32Array(Array.from(v)).buffer).toString("base64");
export const unpackVector = (s: string): Float32Array => {
  const buf = Buffer.from(s, "base64");
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
};
