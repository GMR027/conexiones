import { chunkPage, type Chunk } from "../core/chunk";
import { parseMarkdown } from "../core/html";
import { stripHidden } from "../core/safety";
import type { FetchFn } from "../net/safeFetch";
import type { Library, PageRec, Source } from "../store/library";
import { githubRawUrl } from "./docs";

/** Un paquete de un registro (Packagist, npm…). */
export interface Pkg {
  name: string;
  description: string;
  /** Página del paquete en el registro. */
  url: string;
  repository?: string;
  downloads?: number;
  stars?: number;
  /** El paquete está abandonado (y, si se sabe, qué usar en su lugar). */
  abandoned?: string | true;
  version?: string;
  license?: string;
  install: string;
}

export interface RegistryAdapter {
  id: "packagist" | "npm";
  label: string;
  tags: string[];
  hosts: string[];
  validName(name: string): boolean;
  search(query: string, fetch: FetchFn): Promise<Pkg[]>;
  /** Información completa del paquete en Markdown (cabecera + README si hay). */
  details(name: string, fetch: FetchFn): Promise<{ pkg: Pkg; markdown: string }>;
}

const str = (v: unknown, max = 500): string => (typeof v === "string" ? stripHidden(v).slice(0, max) : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const parse = (text: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("El registro devolvió una respuesta que no se entiende.");
  }
};
const JSON_ONLY = ["application/json", "text/json", "text/plain"];

/** README del repositorio (si está en GitHub), recortado. Si no hay, cadena vacía. */
async function readme(repo: string | undefined, fetch: FetchFn): Promise<string> {
  const raw = repo && githubRawUrl(repo.replace(/^git\+/, "").replace(/^git:\/\//, "https://").replace(/^ssh:\/\/git@/, "https://"));
  if (!raw) return "";
  try {
    return (await fetch(raw, { accept: ["text/"], maxBytes: 200 * 1024 })).text.slice(0, 60_000);
  } catch {
    return "";
  }
}

function header(pkg: Pkg, extra: string[]): string {
  const lines = [
    `# ${pkg.name}`,
    pkg.description,
    `Instalar: \`${pkg.install}\``,
    pkg.version && `Última versión: ${pkg.version}`,
    pkg.license && `Licencia: ${pkg.license}`,
    pkg.abandoned && `ABANDONADO${typeof pkg.abandoned === "string" ? `; usa ${pkg.abandoned}` : ""}`,
    pkg.repository && `Repositorio: ${pkg.repository}`,
    ...extra,
  ].filter(Boolean) as string[];
  return lines.join("\n\n");
}

export const packagist: RegistryAdapter = {
  id: "packagist",
  label: "Packagist (PHP · Composer)",
  tags: ["php", "composer"],
  hosts: ["packagist.org", "www.packagist.org"],
  validName: (n) => /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(n) && n.length <= 120,
  async search(query, fetch) {
    const q = encodeURIComponent(query.slice(0, 100));
    const j = parse((await fetch(`https://packagist.org/search.json?q=${q}&per_page=8`, { accept: JSON_ONLY, maxBytes: 512 * 1024 })).text);
    return (Array.isArray(j.results) ? j.results : []).slice(0, 8).filter((r: any) => packagist.validName(str(r?.name))).map(
      (r: any): Pkg => ({
        name: str(r.name),
        description: str(r.description, 300),
        url: `https://packagist.org/packages/${str(r.name)}`,
        repository: str(r.repository) || undefined,
        downloads: num(r.downloads),
        stars: num(r.favers),
        abandoned: r.abandoned ? (typeof r.abandoned === "string" ? str(r.abandoned, 120) : true) : undefined,
        install: `composer require ${str(r.name)}`,
      }),
    );
  },
  async details(name, fetch) {
    if (!packagist.validName(name)) throw new Error("Nombre de paquete no válido.");
    const j = parse((await fetch(`https://repo.packagist.org/p2/${name.toLowerCase()}.json`, { accept: JSON_ONLY, maxBytes: 3 * 1024 * 1024 })).text);
    const versions: any[] = j?.packages?.[name.toLowerCase()] ?? [];
    const v = versions.find((x) => !/dev/i.test(str(x?.version))) ?? versions[0];
    if (!v) throw new Error(`Packagist no tiene «${name}».`);
    const repo = str(v.source?.url) || str(v.homepage) || undefined;
    const pkg: Pkg = {
      name: str(v.name) || name,
      description: str(v.description, 300),
      url: `https://packagist.org/packages/${name.toLowerCase()}`,
      repository: repo?.replace(/\.git$/, ""),
      abandoned: v.abandoned ? (typeof v.abandoned === "string" ? str(v.abandoned, 120) : true) : undefined,
      version: str(v.version, 40),
      license: Array.isArray(v.license) ? v.license.map((l: unknown) => str(l, 40)).join(", ") : undefined,
      install: `composer require ${name.toLowerCase()}`,
    };
    const req = v.require && typeof v.require === "object" ? Object.entries(v.require).slice(0, 15).map(([k, x]) => `${str(k, 60)} ${str(x, 40)}`) : [];
    const kw = Array.isArray(v.keywords) ? v.keywords.slice(0, 12).map((k: unknown) => str(k, 30)).join(", ") : "";
    const extra = [req.length && `Requiere: ${req.join(", ")}`, kw && `Palabras clave: ${kw}`].filter(Boolean) as string[];
    const body = await readme(repo, fetch);
    return { pkg, markdown: `${header(pkg, extra)}${body ? `\n\n## README\n\n${body}` : ""}` };
  },
};

const NPM_NAME = /^(@[a-z0-9~-][a-z0-9._~-]*\/)?[a-z0-9~-][a-z0-9._~-]*$/;

export const npm: RegistryAdapter = {
  id: "npm",
  label: "npm (JavaScript · Node)",
  tags: ["javascript", "typescript", "node", "npm"],
  hosts: ["npmjs.com", "www.npmjs.com", "registry.npmjs.org"],
  validName: (n) => NPM_NAME.test(n) && n.length <= 214,
  async search(query, fetch) {
    const q = encodeURIComponent(query.slice(0, 100));
    const j = parse((await fetch(`https://registry.npmjs.org/-/v1/search?text=${q}&size=8`, { accept: JSON_ONLY, maxBytes: 1024 * 1024 })).text);
    return (Array.isArray(j.objects) ? j.objects : []).slice(0, 8).filter((o: any) => npm.validName(str(o?.package?.name))).map(
      (o: any): Pkg => ({
        name: str(o.package.name),
        description: str(o.package.description, 300),
        url: `https://www.npmjs.com/package/${str(o.package.name)}`,
        repository: str(o.package.links?.repository) || undefined,
        downloads: num(o.downloads?.monthly),
        version: str(o.package.version, 40),
        install: `npm install ${str(o.package.name)}`,
      }),
    );
  },
  async details(name, fetch) {
    if (!npm.validName(name)) throw new Error("Nombre de paquete no válido.");
    const j = parse((await fetch(`https://registry.npmjs.org/${name.replace("/", "%2f")}/latest`, { accept: JSON_ONLY, maxBytes: 1024 * 1024 })).text);
    const repo = str(typeof j.repository === "string" ? j.repository : j.repository?.url) || str(j.homepage) || undefined;
    const pkg: Pkg = {
      name: str(j.name) || name,
      description: str(j.description, 300),
      url: `https://www.npmjs.com/package/${name}`,
      repository: repo?.replace(/^git\+/, "").replace(/\.git$/, ""),
      version: str(j.version, 40),
      license: typeof j.license === "string" ? str(j.license, 40) : undefined,
      install: `npm install ${name}`,
    };
    const deps = j.dependencies && typeof j.dependencies === "object" ? Object.keys(j.dependencies).slice(0, 15).map((k) => str(k, 60)) : [];
    const kw = Array.isArray(j.keywords) ? j.keywords.slice(0, 12).map((k: unknown) => str(k, 30)).join(", ") : "";
    const extra = [deps.length && `Dependencias: ${deps.join(", ")}`, kw && `Palabras clave: ${kw}`].filter(Boolean) as string[];
    const body = await readme(repo, fetch);
    return { pkg, markdown: `${header(pkg, extra)}${body ? `\n\n## README\n\n${body}` : ""}` };
  },
};

export const REGISTRIES: Record<string, RegistryAdapter> = { packagist, npm };

/** Resultados de búsqueda guardados un rato en memoria para no repetir consultas. */
const searchCache = new Map<string, { at: number; pkgs: Pkg[] }>();
const SEARCH_TTL = 60 * 60 * 1000;

export async function searchRegistry(adapter: RegistryAdapter, query: string, fetch: FetchFn, now = Date.now()): Promise<Pkg[]> {
  const key = `${adapter.id}:${query.trim().toLowerCase()}`;
  const hit = searchCache.get(key);
  if (hit && now - hit.at < SEARCH_TTL) return hit.pkgs;
  const pkgs = await adapter.search(query.trim(), fetch);
  searchCache.set(key, { at: now, pkgs });
  if (searchCache.size > 200) searchCache.delete(searchCache.keys().next().value as string);
  return pkgs;
}

export function clearSearchCache(): void {
  searchCache.clear();
}

/** Guarda un paquete en la biblioteca de su conexión (una «página» por paquete) para usarlo sin conexión. */
export async function savePackage(lib: Library, source: Source, adapter: RegistryAdapter, name: string, fetch: FetchFn): Promise<{ pkg: Pkg; chunks: Chunk[] }> {
  const { pkg, markdown } = await adapter.details(name, fetch);
  const chunks = chunkPage(pkg.url, pkg.name, parseMarkdown(markdown));
  const data = await lib.data(source.id);
  const rec: PageRec = { url: pkg.url, title: pkg.name, fetchedAt: Date.now(), hash: String(markdown.length), chunkIds: chunks.map((c) => c.id) };
  const pages = [rec, ...data.pages.filter((p) => p.url !== pkg.url)].slice(0, Math.max(10, source.maxPages));
  const keep = new Set(pages.map((p) => p.url));
  await lib.saveData(source.id, { pages, chunks: [...chunks, ...data.chunks.filter((c) => c.url !== pkg.url && keep.has(c.url))] }, { lastSync: Date.now(), status: "ok", error: undefined });
  return { pkg, chunks };
}
