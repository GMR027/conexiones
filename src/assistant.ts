import { answerRequest, CONTEXT_CHARS, keywordsRequest, parseKeywords, type SourceText } from "./core/assistantPrompts";
import type { Chunk } from "./core/chunk";
import { tagBoost } from "./core/project";
import { fuse, SearchIndex } from "./core/search";
import type { ChatRequest } from "./core/types";
import { REGISTRIES, savePackage, searchRegistry, type Pkg } from "./connectors/registry";
import type { FetchFn } from "./net/safeFetch";
import type { Library, Source } from "./store/library";

export interface AssistantDeps {
  lib: Library;
  fetch: FetchFn;
  /** Llama a la IA; undefined si no hay IA lista (entonces solo se buscan fragmentos). */
  ask?: (req: ChatRequest, what: string, opts?: { quiet?: boolean }) => Promise<string | undefined>;
  /** Búsqueda por significado opcional (embeddings): devuelve trozos ordenados. */
  semantic?: (question: string, chunks: Chunk[]) => Promise<Chunk[]>;
  projectTags: string[];
  stackText: string;
  lang: string;
  /** Avisa de en qué paso va (para mostrarlo mientras se espera). */
  onPhase?: (text: string) => void;
}

export interface SourceRef {
  n: number;
  title: string;
  url: string;
  source: string;
}

export interface Fragment {
  title: string;
  url: string;
  heading: string;
  text: string;
  source: string;
  hasCode: boolean;
}

export interface Answer {
  question: string;
  answer?: string;
  sources: SourceRef[];
  fragments: Fragment[];
  packages: Pkg[];
  notes: string[];
}

let cached: { key: string; index: SearchIndex; owners: Map<string, Source> } | undefined;

async function indexFor(deps: AssistantDeps) {
  const key = `${deps.lib.version}|${deps.projectTags.join(",")}`;
  if (cached?.key === key) return cached;
  const all = await deps.lib.activeChunks();
  const owners = new Map(all.map((a) => [a.chunk.id, a.source]));
  const index = new SearchIndex(all.map((a) => a.chunk), (c) => tagBoost(owners.get(c.id)?.tags ?? [], deps.projectTags));
  cached = { key, index, owners };
  return cached;
}

const snippet = (t: string, max = 420) => (t.length > max ? `${t.slice(0, max).trimEnd()}…` : t);

/**
 * El asistente: entiende la pregunta, busca en la biblioteca (y en los registros de paquetes conectados),
 * y responde con citas usando solo lo encontrado. Sin IA lista, devuelve los fragmentos más relevantes.
 */
export async function ask(question: string, deps: AssistantDeps): Promise<Answer> {
  const out: Answer = { question, sources: [], fragments: [], packages: [], notes: [] };
  const { index, owners } = await indexFor(deps);
  const sources = deps.lib.list().filter((s) => s.enabled);
  const registries = sources.filter((s) => s.kind === "registry" && REGISTRIES[s.adapter]);

  // 1) Términos de búsqueda (la IA traduce «enviar correos» a «send email»; sin IA se usa la pregunta tal cual).
  let kw = { keywords: [] as string[], package: "" };
  deps.onPhase?.("Entendiendo tu pregunta…");
  if (deps.ask && (index.size || registries.length)) {
    const raw = await deps.ask(keywordsRequest(question, deps.stackText), "buscando en tu biblioteca", { quiet: true }).catch(() => undefined);
    if (raw) kw = parseKeywords(raw);
  }

  // 2) Biblioteca local.
  deps.onPhase?.("Buscando en tu biblioteca…");
  let hits = index.search(question, 12, kw.keywords).map((h) => h.chunk);
  if (deps.semantic && index.size) {
    try {
      const sem = await deps.semantic(question, hits);
      if (sem.length) hits = fuse([hits, sem], 12);
    } catch {
      out.notes.push("La búsqueda por significado no estuvo disponible; se usó la de palabras.");
    }
  }
  const flagged = hits.filter((c) => c.flagged?.length);
  if (flagged.length) out.notes.push(`${flagged.length} fragmento(s) se omitieron porque parecen dar órdenes a la IA (${flagged[0].flagged![0]}).`);
  hits = hits.filter((c) => !c.flagged?.length);

  // 3) Registros de paquetes (Packagist, npm…): primero los que encajan con el proyecto.
  const fresh: Chunk[] = [];
  const extraOwners = new Map<string, string>();
  const ordered = [...registries].sort((a, b) => Number(b.tags.some((t) => deps.projectTags.includes(t))) - Number(a.tags.some((t) => deps.projectTags.includes(t))));
  const wantPackages = deps.ask ? !!kw.package : true;
  if (wantPackages && registries.length) deps.onPhase?.("Consultando los registros de paquetes…");
  if (wantPackages) {
    const matching = ordered.filter((s) => s.tags.some((t) => deps.projectTags.includes(t)));
    for (const s of (matching.length ? matching : ordered).slice(0, 2)) {
      const adapter = REGISTRIES[s.adapter];
      try {
        const pkgs = await searchRegistry(adapter, kw.package || question, deps.fetch);
        out.packages.push(...pkgs.slice(0, 5));
        for (const p of pkgs.filter((x) => !x.abandoned).slice(0, 2)) {
          const known = hits.some((c) => c.url === p.url);
          if (known) continue;
          try {
            const saved = (await savePackage(deps.lib, s, adapter, p.name, deps.fetch)).chunks.slice(0, 3);
            for (const c of saved) extraOwners.set(c.id, s.name);
            fresh.push(...saved);
          } catch (e) {
            out.notes.push(`No pude leer «${p.name}» en ${adapter.label}: ${(e as Error).message}`);
          }
        }
      } catch (e) {
        out.notes.push(`${adapter.label}: ${(e as Error).message}`);
      }
    }
  }

  // 4) Contexto numerado, dentro del presupuesto.
  const chosen: Chunk[] = [];
  let used = 0;
  for (const c of [...fresh, ...hits]) {
    if (chosen.some((x) => x.id === c.id) || c.flagged?.length) continue;
    if (used + c.text.length > CONTEXT_CHARS && chosen.length) continue;
    chosen.push(c);
    used += c.text.length;
    if (chosen.length >= 8) break;
  }
  const ownerName = (c: Chunk) => owners.get(c.id)?.name ?? extraOwners.get(c.id) ?? "Biblioteca";
  const urls: string[] = [];
  const texts: SourceText[] = chosen.map((c) => {
    let i = urls.indexOf(c.url);
    if (i < 0) i = urls.push(c.url) - 1;
    if (!out.sources.some((s) => s.url === c.url)) out.sources.push({ n: i + 1, title: c.title, url: c.url, source: ownerName(c) });
    return { n: i + 1, title: c.title, url: c.url, heading: c.heading, text: c.text };
  });
  out.fragments = chosen.map((c) => ({ title: c.title, url: c.url, heading: c.heading, text: snippet(c.text), source: ownerName(c), hasCode: c.hasCode }));

  deps.onPhase?.(`Leyendo ${chosen.length} fragmento(s)…`);
  if (!chosen.length) {
    out.notes.push(sources.length ? "No encontré nada relacionado en tus conexiones. Prueba con otras palabras o conecta más sitios." : "Aún no tienes conexiones. Añade sitios en la pestaña «Conexiones».");
    return out;
  }
  if (!deps.ask) {
    out.notes.push("Sin IA lista: te muestro los fragmentos más relevantes.");
    return out;
  }
  deps.onPhase?.("Redactando la respuesta…");
  out.answer = (await deps.ask(answerRequest(question, deps.stackText, texts, deps.lang), "preparando la respuesta")) || undefined;
  return out;
}

/** Olvida el índice en memoria (al borrar datos). */
export function resetAssistantCache(): void {
  cached = undefined;
}
