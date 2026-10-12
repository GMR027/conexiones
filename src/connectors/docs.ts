import { createHash } from "node:crypto";
import { chunkPage, type Chunk } from "../core/chunk";
import { parseHtml, parseMarkdown, type Block } from "../core/html";
import { stripHidden } from "../core/safety";
import { ALLOW_ALL, parseRobots, type Robots } from "../net/robots";
import type { FetchFn } from "../net/safeFetch";
import type { Library, PageRec, Source, SourceData } from "../store/library";

export interface SyncCtx {
  lib: Library;
  fetch: FetchFn;
  signal?: AbortSignal;
  /** Pausa entre páginas (ms). */
  delayMs: number;
  progress?: (done: number, total: number, message: string) => void;
  /** Solo pruebas: sin esperas. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncResult {
  pages: number;
  chunks: number;
  fetched: number;
  unchanged: number;
  skipped: number;
  cancelled: boolean;
  notes: string[];
}

const DOC_TYPES = ["text/html", "application/xhtml+xml", "text/plain", "text/markdown", "text/x-markdown"];
const SKIP_EXT = /\.(png|jpe?g|gif|webp|svg|ico|pdf|zip|gz|tgz|rar|7z|exe|dmg|iso|mp[34]|webm|mov|avi|woff2?|ttf|eot|css|js|json|xml|map|csv|xlsx?|docx?|pptx?)$/i;
const MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const MIN_TEXT = 200;
const hash = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 16);

/** Carpeta de una dirección: lo que cuelga de ella es el «ámbito» del rastreo. */
export function scopeOf(url: URL): string {
  const p = url.pathname;
  if (p.endsWith("/")) return p;
  const last = p.split("/").pop() ?? "";
  return last.includes(".") ? p.slice(0, p.lastIndexOf("/") + 1) : `${p}/`;
}

/** Normaliza un enlace de rastreo: sin #, sin consulta (evita calendarios infinitos) y dentro del sitio y la carpeta. */
export function crawlTarget(link: string, start: URL, scope: string, keepQuery = false): string | undefined {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return undefined;
  }
  // Muchos mapas del sitio antiguos listan http:// aunque el sitio ya sea https: se sube a https (nunca al revés).
  if (u.protocol === "http:" && start.protocol === "https:" && u.hostname === start.hostname && !u.port) u.protocol = "https:";
  if (u.origin !== start.origin || SKIP_EXT.test(u.pathname)) return undefined;
  if (!(u.pathname.startsWith(scope) || u.pathname === scope.replace(/\/$/, ""))) return undefined;
  u.hash = "";
  if (!keepQuery) u.search = "";
  return u.href;
}

/** Direcciones <loc> de un sitemap. */
export function parseSitemap(xml: string): { urls: string[]; children: string[] } {
  const locs = [...xml.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, "&"));
  return /<sitemapindex/i.test(xml) ? { urls: [], children: locs.slice(0, 5) } : { urls: locs.slice(0, 5000), children: [] };
}

async function discover(start: URL, scope: string, robots: Robots, ctx: SyncCtx, notes: string[]): Promise<string[]> {
  const found: string[] = [];
  const add = (l: string) => {
    const t = crawlTarget(l, start, scope);
    if (t && !found.includes(t)) found.push(t);
  };
  // 1) llms.txt: índice de documentación pensado para lectores automáticos.
  try {
    const r = await ctx.fetch(`${start.origin}/llms.txt`, { accept: ["text/"], maxBytes: 512 * 1024 });
    for (const m of r.text.matchAll(/\]\(([^)\s]+)\)/g)) add(new URL(m[1], start).href);
    if (found.length) notes.push(`Índice llms.txt: ${found.length} páginas`);
  } catch {
    // no existe: normal
  }
  // 2) sitemap.xml (el que declara robots.txt o el de siempre).
  if (found.length < 5) {
    const maps = robots.sitemaps.filter((s) => s.startsWith(start.origin)).slice(0, 3);
    if (!maps.length) maps.push(`${start.origin}/sitemap.xml`);
    for (const m of maps) {
      try {
        const r = await ctx.fetch(m, { accept: ["application/xml", "text/xml", "text/plain"], maxBytes: 3 * 1024 * 1024 });
        const { urls, children } = parseSitemap(r.text);
        urls.forEach(add);
        for (const c of children) {
          if (ctx.signal?.aborted) break;
          if (!c.startsWith(start.origin) || /\.gz$/i.test(c)) continue;
          try {
            parseSitemap((await ctx.fetch(c, { accept: ["application/xml", "text/xml", "text/plain"], maxBytes: 3 * 1024 * 1024 })).text).urls.forEach(add);
          } catch {
            // un sitemap hijo roto no impide seguir
          }
        }
      } catch {
        // sin sitemap
      }
    }
    if (found.length) notes.push(`Mapa del sitio: ${found.length} páginas en la carpeta`);
  }
  return found;
}

/**
 * Lee un sitio de documentación y guarda su texto en la biblioteca: respeta robots.txt, va despacio, no sale del sitio
 * ni de la carpeta indicada, solo acepta HTML o texto, y vuelve a descargar solo lo que cambió. Cancelable.
 */
export async function syncDocs(source: Source, ctx: SyncCtx): Promise<SyncResult> {
  const sleep = ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const raw = source.adapter === "github" ? githubRawUrl(source.url) : undefined;
  if (source.adapter === "github" && !raw) throw new Error("No reconozco esa dirección de GitHub (usa github.com/usuario/repositorio).");
  const start = new URL(raw ?? source.url);
  const result: SyncResult = { pages: 0, chunks: 0, fetched: 0, unchanged: 0, skipped: 0, cancelled: false, notes: [] };
  return crawl(source, start, scopeOf(start), ctx, sleep, result);
}

async function crawl(source: Source, start: URL, scope: string, ctx: SyncCtx, sleep: (ms: number) => Promise<void>, result: SyncResult): Promise<SyncResult> {
  const notes = result.notes;
  // robots.txt se pide con la misma función de descarga (misma política).
  const robots = await robotsVia(start, ctx);
  if (!robots.allows(start.pathname + start.search)) {
    throw new Error("El sitio no permite que lectores automáticos visiten esa página (robots.txt).");
  }
  const delay = Math.max(ctx.delayMs, robots.crawlDelay * 1000);
  const previous = await ctx.lib.data(source.id);
  const prevPages = new Map(previous.pages.map((p) => [p.url, p]));
  const prevChunks = new Map<string, Chunk[]>();
  for (const c of previous.chunks) prevChunks.set(c.url, [...(prevChunks.get(c.url) ?? []), c]);
  const pages = new Map<string, PageRec>();
  const chunks = new Map<string, Chunk[]>();
  const hashes = new Set<string>();

  const queue: string[] = [start.href];
  const seen = new Set(queue);
  const seeds = source.adapter === "docs" ? await discover(start, scope, robots, ctx, notes) : [];
  for (const s of seeds) if (!seen.has(s)) (seen.add(s), queue.push(s));
  const limit = Math.max(1, source.maxPages);
  let bytesTotal = 0;
  let failures = 0;
  let lastError = "";

  const snapshot = (): SourceData => {
    const keptPages = [...pages.values(), ...[...prevPages.values()].filter((p) => !pages.has(p.url))].slice(0, limit * 2);
    const all = keptPages.flatMap((p) => chunks.get(p.url) ?? prevChunks.get(p.url) ?? []);
    return { pages: keptPages, chunks: all };
  };

  for (let i = 0; i < queue.length && pages.size < limit; i++) {
    if (ctx.signal?.aborted) {
      result.cancelled = true;
      break;
    }
    const url = queue[i];
    const u = new URL(url);
    if (!robots.allows(u.pathname + u.search)) {
      result.skipped++;
      continue;
    }
    ctx.progress?.(pages.size, Math.min(queue.length, limit), url.replace(/^https?:\/\//, ""));
    if (i > 0) await sleep(delay);
    const prev = prevPages.get(url);
    try {
      const r = await ctx.fetch(url, { accept: DOC_TYPES, maxBytes: 1.5 * 1024 * 1024, etag: prev?.etag, lastModified: prev?.lastModified });
      bytesTotal += r.bytes.length;
      // Una redirección a otro sitio no se indexa como si fuera de este (solo se tolera el cambio http → https).
      if (new URL(r.url).hostname !== start.hostname) {
        result.skipped++;
        notes.push(`Redirigida a otro sitio, omitida: ${url}`);
        continue;
      }
      if (r.notModified && prev) {
        pages.set(url, { ...prev, fetchedAt: Date.now() });
        result.unchanged++;
        continue;
      }
      const type = (r.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      let title: string;
      let blocks: Block[];
      let links: string[] = [];
      if (type.includes("html")) {
        const p = parseHtml(r.text, r.url);
        title = p.title || u.pathname;
        blocks = p.blocks;
        links = p.links;
      } else {
        blocks = parseMarkdown(r.text);
        title = blocks.find((b) => b.type === "h")?.text ?? u.pathname.split("/").pop() ?? u.pathname;
      }
      const plain = blocks.map((b) => b.text).join(" ");
      if (plain.length < MIN_TEXT) {
        result.skipped++;
      } else {
        const h = hash(plain);
        if (hashes.has(h)) {
          result.skipped++; // misma página con otra dirección
        } else {
          hashes.add(h);
          const cs = chunkPage(r.url, stripHidden(title).slice(0, 200), blocks);
          pages.set(url, { url, title: stripHidden(title).slice(0, 200), etag: r.headers.etag, lastModified: r.headers["last-modified"], fetchedAt: Date.now(), hash: h, chunkIds: cs.map((c) => c.id) });
          chunks.set(url, cs);
          result.fetched++;
        }
      }
      if (source.adapter === "docs") {
        for (const l of links) {
          const t = crawlTarget(l, start, scope);
          if (t && !seen.has(t) && queue.length < limit * 4) (seen.add(t), queue.push(t));
        }
      }
      if (pages.size > 0 && pages.size % 25 === 0) await ctx.lib.saveData(source.id, snapshot());
      if (bytesTotal > MAX_TOTAL_BYTES) {
        notes.push("Se detuvo al llegar al límite de descarga de una sincronización (40 MB).");
        break;
      }
    } catch (e) {
      const err = e as { kind?: string; status?: number; message: string };
      if (err.kind === "aborted") {
        result.cancelled = true;
        break;
      }
      if (err.status === 404 || err.status === 410) {
        prevPages.delete(url);
        prevChunks.delete(url);
      } else {
        failures++;
        lastError = err.message;
        if (err.kind === "blocked") notes.push(`Bloqueada por seguridad: ${url} (${err.message})`);
      }
      if (i === 0 && !pages.size) throw new Error(err.status === 403 ? "El sitio rechaza a los lectores automáticos (403). No se intenta saltar esa protección." : err.message);
      if (failures >= 8 && !pages.size) throw new Error(lastError);
    }
  }
  const data = snapshot();
  result.pages = data.pages.length;
  result.chunks = data.chunks.length;
  if (!data.pages.length) throw new Error(lastError || "No encontré texto útil en esa dirección.");
  if (failures) notes.push(`${failures} página(s) no se pudieron leer.`);
  await ctx.lib.saveData(source.id, data, { lastSync: Date.now(), status: "ok", error: undefined });
  return result;
}

async function robotsVia(start: URL, ctx: SyncCtx): Promise<Robots> {
  try {
    const r = await ctx.fetch(`${start.origin}/robots.txt`, { accept: ["text/"], maxBytes: 512 * 1024, timeoutMs: 10_000 });
    return parseRobots(r.text);
  } catch (e) {
    const status = (e as { status?: number }).status;
    return status && status >= 400 && status < 500 ? ALLOW_ALL : { allows: () => false, crawlDelay: 0, sitemaps: [] };
  }
}

/** Dirección del README en bruto de un repositorio de GitHub (o de un .md concreto); undefined si no es GitHub. */
export function githubRawUrl(link: string): string | undefined {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return undefined;
  }
  if (!/^(www\.)?github\.com$/.test(u.hostname)) return undefined;
  const [owner, repo, kind, ref, ...rest] = u.pathname.split("/").filter(Boolean);
  const ok = (s?: string) => !!s && /^[\w.-]+$/.test(s) && s !== "." && s !== "..";
  if (!ok(owner) || !ok(repo)) return undefined;
  const name = repo.replace(/\.git$/, "");
  if (kind === "blob" && ok(ref) && rest.length && rest.every(ok) && /\.(md|markdown|txt)$/i.test(rest[rest.length - 1])) return `https://raw.githubusercontent.com/${owner}/${name}/${ref}/${rest.join("/")}`;
  return `https://raw.githubusercontent.com/${owner}/${name}/HEAD/README.md`;
}
