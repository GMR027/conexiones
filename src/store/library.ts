import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import * as path from "node:path";
import type { Chunk } from "../core/chunk";

/** Tipos de conexión. */
export type SourceKind = "docs" | "registry" | "icons" | "fonts" | "images" | "mcp";

export interface Source {
  id: string;
  kind: SourceKind;
  /** Quién la atiende: «docs», «github», «packagist», «npm», «fontawesome», «unsplash», «mcp-http»… */
  adapter: string;
  name: string;
  url: string;
  /** Lenguajes o tecnologías a las que se refiere («php», «css»…); sirven para dar prioridad según el proyecto. */
  tags: string[];
  enabled: boolean;
  addedAt: number;
  lastSync?: number;
  status: "ok" | "error" | "pending" | "syncing";
  error?: string;
  pages: number;
  chunks: number;
  /** Espacio en disco de lo guardado de esta conexión. */
  bytes: number;
  ttlHours: number;
  maxPages: number;
  /** Datos propios del tipo de conexión (p. ej. el encabezado de la clave de un MCP). */
  meta?: Record<string, string | number | boolean>;
}

export interface PageRec {
  url: string;
  title: string;
  etag?: string;
  lastModified?: string;
  fetchedAt: number;
  hash: string;
  chunkIds: string[];
}

export interface SourceData {
  pages: PageRec[];
  chunks: Chunk[];
}

export class StoreError extends Error {}

const ID = /^src-[0-9a-f]{8}$/;
const FILE = /^[a-z0-9][a-z0-9._-]{0,40}\.json$/;
export const isSourceId = (id: unknown): id is string => typeof id === "string" && ID.test(id);

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

/** Escritura atómica: se escribe aparte y se renombra, para no dejar archivos a medias. */
async function writeJson(file: string, data: unknown): Promise<number> {
  const text = JSON.stringify(data);
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
  return Buffer.byteLength(text);
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    total += e.isDirectory() ? await dirSize(p) : (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

/**
 * Biblioteca local: todo lo que se recoge de las conexiones vive en una carpeta propia de la extensión
 * (`<root>/sources/<id>/`). Al quitar una conexión se borra su carpeta entera. Los identificadores se validan
 * antes de tocar el disco y nunca se sale de `root`.
 */
export class Library {
  private sources: Source[] = [];
  private readonly cache = new Map<string, SourceData>();
  private chain: Promise<unknown> = Promise.resolve();
  /** Cambia con cada modificación de datos; sirve para saber si hay que reconstruir el índice de búsqueda. */
  version = 0;

  constructor(readonly root: string, private readonly maxBytes = 200 * 1024 * 1024) {}

  private get sourcesFile(): string {
    return path.join(this.root, "sources.json");
  }
  private dir(id: string): string {
    if (!isSourceId(id)) throw new StoreError("Identificador de conexión no válido.");
    const d = path.resolve(this.root, "sources", id);
    if (!d.startsWith(path.resolve(this.root, "sources") + path.sep)) throw new StoreError("Ruta fuera de la biblioteca.");
    return d;
  }

  /** Serializa las operaciones que escriben. */
  private lock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  async init(): Promise<void> {
    await mkdir(path.join(this.root, "sources"), { recursive: true });
    const list = await readJson<Source[]>(this.sourcesFile, []);
    this.sources = Array.isArray(list) ? list.filter((s) => isSourceId(s?.id)) : [];
    // Un cierre a mitad de sincronización no deja la conexión «sincronizando» para siempre.
    for (const s of this.sources) if (s.status === "syncing") s.status = "pending";
    await this.purgeOrphans();
  }

  /** Borra carpetas de datos que ya no pertenecen a ninguna conexión (por ejemplo, tras un cierre a mitad de borrado). */
  async purgeOrphans(): Promise<number> {
    const known = new Set(this.sources.map((s) => s.id));
    let n = 0;
    for (const e of await readdir(path.join(this.root, "sources"), { withFileTypes: true }).catch(() => [])) {
      if (!known.has(e.name)) {
        await rm(path.join(this.root, "sources", e.name), { recursive: true, force: true });
        n++;
      }
    }
    return n;
  }

  list(): Source[] {
    return this.sources.map((s) => ({ ...s }));
  }
  get(id: string): Source | undefined {
    const s = this.sources.find((x) => x.id === id);
    return s && { ...s };
  }

  private saveSources(): Promise<number> {
    return writeJson(this.sourcesFile, this.sources);
  }

  add(init: Pick<Source, "kind" | "adapter" | "name" | "url"> & Partial<Source>): Promise<Source> {
    return this.lock(async () => {
      const source: Source = {
        tags: [],
        enabled: true,
        addedAt: Date.now(),
        status: "pending",
        pages: 0,
        chunks: 0,
        bytes: 0,
        ttlHours: 24,
        maxPages: 150,
        ...init,
        id: `src-${randomBytes(4).toString("hex")}`,
      };
      this.sources.push(source);
      await mkdir(this.dir(source.id), { recursive: true });
      await this.saveSources();
      this.version++;
      return { ...source };
    });
  }

  update(id: string, patch: Partial<Omit<Source, "id">>): Promise<Source | undefined> {
    return this.lock(async () => {
      const s = this.sources.find((x) => x.id === id);
      if (!s) return undefined;
      Object.assign(s, patch);
      await this.saveSources();
      this.version++;
      return { ...s };
    });
  }

  /** Quita la conexión y BORRA todo lo guardado de ella. */
  remove(id: string): Promise<boolean> {
    return this.lock(async () => {
      const i = this.sources.findIndex((x) => x.id === id);
      if (i < 0) return false;
      const dir = this.dir(id);
      this.sources.splice(i, 1);
      this.cache.delete(id);
      await this.saveSources();
      await rm(dir, { recursive: true, force: true });
      this.version++;
      return true;
    });
  }

  /** Borra lo guardado (páginas, trozos, iconos…) pero mantiene la conexión. */
  clearData(id: string): Promise<boolean> {
    return this.lock(async () => {
      const s = this.sources.find((x) => x.id === id);
      if (!s) return false;
      const dir = this.dir(id);
      await rm(dir, { recursive: true, force: true });
      await mkdir(dir, { recursive: true });
      this.cache.delete(id);
      Object.assign(s, { pages: 0, chunks: 0, bytes: 0, lastSync: undefined, status: "pending", error: undefined });
      await this.saveSources();
      this.version++;
      return true;
    });
  }

  /** Quita todas las conexiones y todos los datos. */
  clearAll(): Promise<void> {
    return this.lock(async () => {
      this.sources = [];
      this.cache.clear();
      await this.saveSources();
      await rm(path.join(this.root, "sources"), { recursive: true, force: true });
      await mkdir(path.join(this.root, "sources"), { recursive: true });
      this.version++;
    });
  }

  async data(id: string): Promise<SourceData> {
    const hit = this.cache.get(id);
    if (hit) return hit;
    const d = await readJson<Partial<SourceData>>(path.join(this.dir(id), "pages.json"), {});
    const data: SourceData = { pages: Array.isArray(d.pages) ? d.pages : [], chunks: Array.isArray(d.chunks) ? d.chunks : [] };
    this.cache.set(id, data);
    return data;
  }

  /** Guarda páginas y trozos de una conexión y actualiza sus números. */
  saveData(id: string, data: SourceData, patch: Partial<Source> = {}): Promise<void> {
    return this.lock(async () => {
      const s = this.sources.find((x) => x.id === id);
      if (!s) throw new StoreError("La conexión ya no existe.");
      const others = (await this.totalBytes()) - s.bytes;
      const bytes = await writeJson(path.join(this.dir(id), "pages.json"), data);
      if (others + bytes > this.maxBytes) {
        await rm(path.join(this.dir(id), "pages.json"), { force: true });
        this.cache.delete(id);
        throw new StoreError(`Se superaría el espacio máximo de la biblioteca (${Math.round(this.maxBytes / 1048576)} MB). Libera espacio o súbelo en Ajustes.`);
      }
      this.cache.set(id, data);
      Object.assign(s, { pages: data.pages.length, chunks: data.chunks.length, bytes: bytes + (await this.extraBytes(id)) }, patch);
      await this.saveSources();
      this.version++;
    });
  }

  private async extraBytes(id: string): Promise<number> {
    return (await dirSize(this.dir(id))) - (await stat(path.join(this.dir(id), "pages.json")).then((x) => x.size, () => 0));
  }

  /** Archivo JSON propio de una conexión (iconos, vectores…). */
  async readFile<T>(id: string, name: string, fallback: T): Promise<T> {
    if (!FILE.test(name)) throw new StoreError("Nombre de archivo no válido.");
    return readJson(path.join(this.dir(id), name), fallback);
  }
  writeFile(id: string, name: string, data: unknown): Promise<void> {
    return this.lock(async () => {
      if (!FILE.test(name)) throw new StoreError("Nombre de archivo no válido.");
      const s = this.sources.find((x) => x.id === id);
      if (!s) throw new StoreError("La conexión ya no existe.");
      const size = await writeJson(path.join(this.dir(id), name), data);
      if ((await this.totalBytes()) > this.maxBytes) {
        await rm(path.join(this.dir(id), name), { force: true });
        throw new StoreError(`Se superaría el espacio máximo de la biblioteca (${Math.round(this.maxBytes / 1048576)} MB).`);
      }
      s.bytes = await dirSize(this.dir(id));
      void size;
      await this.saveSources();
      this.version++;
    });
  }

  /** Todos los trozos de las conexiones de documentación y paquetes que están activas. */
  async activeChunks(): Promise<{ chunk: Chunk; source: Source }[]> {
    const out: { chunk: Chunk; source: Source }[] = [];
    for (const s of this.sources) {
      if (!s.enabled || (s.kind !== "docs" && s.kind !== "registry")) continue;
      for (const chunk of (await this.data(s.id)).chunks) out.push({ chunk, source: { ...s } });
    }
    return out;
  }

  totalBytes(): Promise<number> {
    return dirSize(path.join(this.root, "sources"));
  }
}
