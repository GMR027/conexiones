import type { Chunk } from "./core/chunk";
import { cosine, packVector, unpackVector } from "./core/search";
import type { Library, Source } from "./store/library";

const EMBED_NAME = /embed|bge-|minilm|e5-|gte-|arctic-embed|nomic/i;

export interface VectorFile {
  model: string;
  /** id de trozo → vector (Float32 en base64). */
  v: Record<string, string>;
}

const join = (base: string, p: string) => base.replace(/\/+$/, "") + p;

/** Modelo de embeddings ya descargado en Ollama (el indicado en ajustes o el primero que parezca uno). */
export async function findEmbedModel(url: string, wanted: string): Promise<string | undefined> {
  const res = await fetch(join(url, "/api/tags"), { signal: AbortSignal.timeout(5000) });
  if (!res.ok) return undefined;
  const names = ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  if (wanted) return names.includes(wanted) ? wanted : undefined;
  return names.find((n) => EMBED_NAME.test(n));
}

/** Vectores de varios textos con Ollama. Se descarga el modelo de memoria al minuto (keep_alive) para no competir con el de chat. */
export async function embed(url: string, model: string, texts: string[], signal?: AbortSignal): Promise<number[][]> {
  const res = await fetch(join(url, "/api/embed"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input: texts.map((t) => t.slice(0, 2000)), keep_alive: "1m" }),
    signal: signal ?? AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`Ollama respondió ${res.status} al calcular los vectores.`);
  const j = (await res.json()) as { embeddings?: number[][] };
  if (!Array.isArray(j.embeddings) || j.embeddings.length !== texts.length) throw new Error("Ollama devolvió vectores incompletos.");
  return j.embeddings;
}

const textOf = (c: Chunk) => `${c.title} — ${c.heading}\n${c.text}`;

/** Calcula los vectores que faltan de una conexión (por lotes) y los guarda. Devuelve cuántos trozos tiene ya con vector. */
export async function buildVectors(lib: Library, source: Source, url: string, model: string, progress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<number> {
  const chunks = (await lib.data(source.id)).chunks.filter((c) => !c.flagged?.length);
  const file = await lib.readFile<VectorFile>(source.id, "vectors.json", { model, v: {} });
  const have = file.model === model ? file.v : {};
  const todo = chunks.filter((c) => !have[c.id]);
  const v: Record<string, string> = {};
  for (const c of chunks) if (have[c.id]) v[c.id] = have[c.id];
  for (let i = 0; i < todo.length; i += 16) {
    if (signal?.aborted) break;
    const batch = todo.slice(i, i + 16);
    const vecs = await embed(url, model, batch.map(textOf), signal);
    batch.forEach((c, j) => (v[c.id] = packVector(vecs[j])));
    progress?.(Math.min(i + 16, todo.length), todo.length);
  }
  await lib.writeFile(source.id, "vectors.json", { model, v } satisfies VectorFile);
  return Object.keys(v).length;
}

/** Los trozos más parecidos en significado a la pregunta (de las conexiones activas que tienen vectores). */
export async function semanticSearch(lib: Library, question: string, url: string, model: string, limit = 12): Promise<Chunk[]> {
  const [q] = await embed(url, model, [question]);
  const scored: { chunk: Chunk; s: number }[] = [];
  for (const s of lib.list()) {
    if (!s.enabled || (s.kind !== "docs" && s.kind !== "registry")) continue;
    const file = await lib.readFile<VectorFile>(s.id, "vectors.json", { model, v: {} });
    if (file.model !== model) continue;
    for (const chunk of (await lib.data(s.id)).chunks) {
      const packed = file.v[chunk.id];
      if (packed && !chunk.flagged?.length) scored.push({ chunk, s: cosine(q, unpackVector(packed)) });
    }
  }
  return scored.filter((x) => x.s > 0.3).sort((a, b) => b.s - a.s).slice(0, limit).map((x) => x.chunk);
}
