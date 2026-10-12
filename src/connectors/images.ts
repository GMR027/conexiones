import { stripHidden } from "../core/safety";
import type { FetchFn } from "../net/safeFetch";

export interface Photo {
  id: string;
  alt: string;
  width: number;
  height: number;
  color: string;
  /** Miniatura en data: URI (se descarga con el filtro de seguridad; la vista no toca la red). */
  thumb?: string;
  small: string;
  regular: string;
  page: string;
  downloadLocation: string;
  author: string;
  authorPage: string;
  /** De qué servicio viene (por defecto, Unsplash). */
  provider?: ImageProvider;
  /** Imagen en su tamaño original, si es distinta de `regular`. */
  original?: string;
  /** Licencia (Openverse): «CC BY 2.0», «CC0»… */
  license?: string;
  licenseUrl?: string;
  /** Título (Openverse). */
  title?: string;
}

export type ImageProvider = "unsplash" | "pexels" | "openverse";

export const IMAGE_PROVIDERS: Record<ImageProvider, { label: string; needsKey: boolean }> = {
  unsplash: { label: "Unsplash", needsKey: true },
  pexels: { label: "Pexels", needsKey: true },
  openverse: { label: "Openverse", needsKey: false },
};

const UTM = "utm_source=conexiones&utm_medium=referral";
const HOST_OK = /^((images|plus|api)\.)?unsplash\.com$/;

const httpsUnsplash = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && HOST_OK.test(u.hostname) ? u.href : undefined;
  } catch {
    return undefined;
  }
};

/** Convierte la respuesta de la API en fotos, descartando todo lo que no sea una dirección de Unsplash. */
export function parsePhotos(json: unknown): Photo[] {
  const results = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(results)) return [];
  const out: Photo[] = [];
  for (const r of results.slice(0, 30) as any[]) {
    const regular = httpsUnsplash(r?.urls?.regular);
    const small = httpsUnsplash(r?.urls?.small);
    const dl = httpsUnsplash(r?.links?.download_location);
    if (!regular || !small || !dl || typeof r?.id !== "string" || !/^[\w-]+$/.test(r.id)) continue;
    out.push({
      id: r.id,
      alt: stripHidden(String(r.alt_description ?? r.description ?? "")).slice(0, 200),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      color: /^#[0-9a-f]{6}$/i.test(r.color) ? r.color : "#cccccc",
      small,
      regular,
      provider: "unsplash",
      original: httpsUnsplash(r?.urls?.full),
      page: `${httpsUnsplash(r?.links?.html) ?? "https://unsplash.com/"}?${UTM}`,
      downloadLocation: dl,
      author: stripHidden(String(r?.user?.name ?? "Unsplash")).slice(0, 80),
      authorPage: `${httpsUnsplash(r?.user?.links?.html) ?? "https://unsplash.com/"}?${UTM}`,
    });
  }
  return out;
}

/** Filtros de búsqueda comunes; cada servicio usa los que entiende. */
export interface ImageFilters {
  orientation?: "landscape" | "portrait" | "square";
  color?: "red" | "orange" | "yellow" | "green" | "teal" | "blue" | "purple" | "pink" | "black" | "white" | "gray";
  /** Unsplash: más relevantes o más recientes. */
  order?: "relevant" | "latest";
  /** Openverse: tipo de imagen. */
  category?: "photograph" | "illustration" | "digital_artwork";
  /** Openverse: solo imágenes que se pueden usar con fines comerciales. */
  commercial?: boolean;
}

export const PAGE_SIZE = 12;
/** Los servicios no dejan pasar de ciertas páginas (Openverse anónimo, unas 240 imágenes). */
export const MAX_PAGES = 20;

const ORIENTATIONS = ["landscape", "portrait", "square"];
const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink", "black", "white", "gray"];
const CATEGORIES = ["photograph", "illustration", "digital_artwork"];

/** Deja solo los valores permitidos (los filtros llegan de la vista y no se fían). */
export function cleanFilters(raw: unknown): ImageFilters {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const pick = <T extends string>(v: unknown, list: string[]): T | undefined => (typeof v === "string" && list.includes(v) ? (v as T) : undefined);
  return {
    orientation: pick(r.orientation, ORIENTATIONS),
    color: pick(r.color, COLORS),
    order: pick(r.order, ["relevant", "latest"]),
    category: pick(r.category, CATEGORIES),
    commercial: r.commercial === true || undefined,
  };
}

const pages = (total: number): number => Math.max(1, Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE)));

export interface PhotoSearch {
  photos: Photo[];
  total: number;
  /** Páginas que se pueden ver. */
  pages: number;
  page: number;
  /** Peticiones que quedan en esta hora (límite de la clave). */
  remaining?: number;
}

/** Miniaturas descargadas por la extensión (con el filtro de red), de cuatro en cuatro. */
async function attachThumbs(photos: Photo[], fetch: FetchFn): Promise<void> {
  for (let i = 0; i < photos.length; i += 4) {
    await Promise.all(
      photos.slice(i, i + 4).map(async (p) => {
        try {
          // Algunos servidores (Openverse) responden 406 si el encabezado Accept es más estricto que «*/*»; el tipo se valida igualmente.
          const t = await fetch(p.small, { accept: ["image/jpeg", "image/png", "image/webp", "image/gif"], headers: { accept: "*/*" }, maxBytes: 600 * 1024, timeoutMs: 15_000 });
          const kind = sniffImage(t.bytes);
          if (kind) p.thumb = `data:image/${kind === "jpg" ? "jpeg" : kind};base64,${t.bytes.toString("base64")}`;
        } catch {
          // sin miniatura: se muestra el color
        }
      }),
    );
  }
}

const parseJson = (text: string, who: string): any => {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${who} devolvió una respuesta que no se entiende.`);
  }
};

const clampPage = (page: number) => Math.max(1, Math.min(MAX_PAGES, Math.floor(page) || 1));

export async function searchPhotos(key: string, query: string, fetch: FetchFn, page = 1, f: ImageFilters = {}): Promise<PhotoSearch> {
  const q = encodeURIComponent(query.slice(0, 100));
  const pg = clampPage(page);
  const extra = [f.orientation && `&orientation=${f.orientation === "square" ? "squarish" : f.orientation}`, f.color && `&color=${f.color === "gray" ? "black_and_white" : f.color === "pink" ? "magenta" : f.color}`, f.order && `&order_by=${f.order}`].filter(Boolean).join("");
  const r = await fetch(`https://api.unsplash.com/search/photos?query=${q}&per_page=${PAGE_SIZE}&page=${pg}${extra}`, {
    accept: ["application/json"],
    headers: { authorization: `Client-ID ${key}`, "accept-version": "v1" },
    sensitiveHeaders: ["authorization"],
    maxBytes: 1024 * 1024,
  });
  const json = parseJson(r.text, "Unsplash");
  const photos = parsePhotos(json);
  const remaining = Number(r.headers["x-ratelimit-remaining"]);
  await attachThumbs(photos, fetch);
  const total = Number(json?.total) || photos.length;
  return { photos, total, pages: pages(Math.min(total, Number(json?.total_pages) * PAGE_SIZE || total)), page: pg, remaining: Number.isFinite(remaining) ? remaining : undefined };
}

// --- Pexels (clave gratuita en pexels.com/api) -----------------------------------------------------

const PEXELS_HOST = /^(images|www)\.pexels\.com$/;
const httpsPexels = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && PEXELS_HOST.test(u.hostname) ? u.href : undefined;
  } catch {
    return undefined;
  }
};

export function parsePexels(json: unknown): Photo[] {
  const list = (json as { photos?: unknown[] })?.photos;
  if (!Array.isArray(list)) return [];
  const out: Photo[] = [];
  for (const r of list.slice(0, 30) as any[]) {
    const regular = httpsPexels(r?.src?.large) ?? httpsPexels(r?.src?.large2x);
    const small = httpsPexels(r?.src?.medium) ?? httpsPexels(r?.src?.small);
    const id = String(r?.id ?? "");
    if (!regular || !small || !/^\d{1,12}$/.test(id)) continue;
    out.push({
      id,
      provider: "pexels",
      alt: stripHidden(String(r.alt ?? "")).slice(0, 200),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      color: /^#[0-9a-f]{6}$/i.test(r.avg_color) ? r.avg_color : "#cccccc",
      small,
      regular,
      original: httpsPexels(r?.src?.original),
      page: httpsPexels(r?.url) ?? "https://www.pexels.com/",
      downloadLocation: "",
      author: stripHidden(String(r?.photographer ?? "Pexels")).slice(0, 80),
      authorPage: httpsPexels(r?.photographer_url) ?? "https://www.pexels.com/",
    });
  }
  return out;
}

export async function searchPexels(key: string, query: string, fetch: FetchFn, page = 1, f: ImageFilters = {}): Promise<PhotoSearch> {
  const q = encodeURIComponent(query.slice(0, 100));
  const pg = clampPage(page);
  const extra = [f.orientation && `&orientation=${f.orientation}`, f.color && `&color=${f.color === "teal" ? "turquoise" : f.color === "purple" ? "violet" : f.color}`].filter(Boolean).join("");
  const r = await fetch(`https://api.pexels.com/v1/search?query=${q}&per_page=${PAGE_SIZE}&page=${pg}${extra}`, {
    accept: ["application/json"],
    headers: { authorization: key },
    sensitiveHeaders: ["authorization"],
    maxBytes: 1024 * 1024,
  });
  const json = parseJson(r.text, "Pexels");
  const photos = parsePexels(json);
  const remaining = Number(r.headers["x-ratelimit-remaining"]);
  await attachThumbs(photos, fetch);
  const total = Number(json?.total_results) || photos.length;
  return { photos, total, pages: pages(total), page: pg, remaining: Number.isFinite(remaining) ? remaining : undefined };
}

// --- Openverse (millones de imágenes con licencia abierta; no necesita clave) -----------------------

const LICENSES: Record<string, string> = { by: "CC BY", "by-sa": "CC BY-SA", "by-nd": "CC BY-ND", "by-nc": "CC BY-NC", "by-nc-sa": "CC BY-NC-SA", "by-nc-nd": "CC BY-NC-ND", cc0: "CC0", pdm: "Dominio público" };
const httpsAny = (v: unknown): string | undefined => {
  if (typeof v !== "string" || v.length > 2000) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : undefined;
  } catch {
    return undefined;
  }
};

export function parseOpenverse(json: unknown): Photo[] {
  const list = (json as { results?: unknown[] })?.results;
  if (!Array.isArray(list)) return [];
  const out: Photo[] = [];
  for (const r of list.slice(0, 30) as any[]) {
    const id = String(r?.id ?? "");
    const url = httpsAny(r?.url);
    const thumb = httpsAny(r?.thumbnail);
    if (!/^[0-9a-f-]{36}$/.test(id) || !url || !thumb || new URL(thumb).hostname !== "api.openverse.org" || r?.mature === true) continue;
    const lic = LICENSES[String(r.license ?? "")] ?? String(r.license ?? "").toUpperCase().slice(0, 12);
    const license = `${lic}${r.license_version && !/^(cc0|pdm)$/.test(String(r.license)) ? ` ${String(r.license_version).slice(0, 5)}` : ""}`.trim();
    out.push({
      id,
      provider: "openverse",
      title: stripHidden(String(r.title ?? "")).slice(0, 120),
      alt: stripHidden(String(r.title ?? "")).slice(0, 200),
      width: Number(r.width) || 0,
      height: Number(r.height) || 0,
      color: "#cccccc",
      small: thumb,
      regular: url,
      page: httpsAny(r.foreign_landing_url) ?? "https://openverse.org/",
      downloadLocation: "",
      author: stripHidden(String(r.creator ?? "Autor desconocido")).slice(0, 80),
      authorPage: httpsAny(r.creator_url) ?? httpsAny(r.foreign_landing_url) ?? "https://openverse.org/",
      license,
      licenseUrl: httpsAny(r.license_url),
    });
  }
  return out;
}

export async function searchOpenverse(query: string, fetch: FetchFn, page = 1, f: ImageFilters = {}): Promise<PhotoSearch> {
  const q = encodeURIComponent(query.slice(0, 100));
  const pg = clampPage(page);
  const extra = [f.orientation && `&aspect_ratio=${f.orientation === "landscape" ? "wide" : f.orientation === "portrait" ? "tall" : "square"}`, f.category && `&category=${f.category}`, f.commercial && "&license_type=commercial"].filter(Boolean).join("");
  const r = await fetch(`https://api.openverse.org/v1/images/?q=${q}&page_size=${PAGE_SIZE}&page=${pg}&mature=false${extra}`, { accept: ["application/json"], maxBytes: 1024 * 1024 });
  const json = parseJson(r.text, "Openverse");
  const photos = parseOpenverse(json);
  await attachThumbs(photos, fetch);
  const total = Number(json?.result_count) || photos.length;
  return { photos, total, pages: pages(Math.min(total, Number(json?.page_count) * PAGE_SIZE || total)), page: pg };
}

/** Busca en el servicio elegido. */
export function searchImages(provider: ImageProvider, key: string | undefined, query: string, fetch: FetchFn, page = 1, filters: ImageFilters = {}): Promise<PhotoSearch> {
  if (provider === "openverse") return searchOpenverse(query, fetch, page, filters);
  if (!key) throw new Error(`Falta la clave de ${IMAGE_PROVIDERS[provider].label}.`);
  return provider === "pexels" ? searchPexels(key, query, fetch, page, filters) : searchPhotos(key, query, fetch, page, filters);
}

/** Unsplash pide avisar cuando se usa una foto. */
export async function trackDownload(key: string, photo: Photo, fetch: FetchFn): Promise<void> {
  await fetch(photo.downloadLocation, { accept: ["application/json"], headers: { authorization: `Client-ID ${key}`, "accept-version": "v1" }, sensitiveHeaders: ["authorization"], maxBytes: 64 * 1024 });
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const imgTag = (p: Photo): string => `<img src="${esc(p.regular)}" alt="${esc(p.alt || "Imagen")}" width="${p.width || 1080}" loading="lazy">`;
export const cssBackground = (p: Photo): string => `background-image: url("${p.regular.replace(/"/g, "%22")}");\nbackground-size: cover;\nbackground-position: center;`;
export const attributionHtml = (p: Photo): string => {
  if (p.provider === "pexels") return `Foto de <a href="${esc(p.authorPage)}">${esc(p.author)}</a> en <a href="https://www.pexels.com/">Pexels</a>`;
  if (p.provider === "openverse") {
    const by = `<a href="${esc(p.authorPage)}">${esc(p.author)}</a>`;
    return `«${esc(p.title || p.alt || "Imagen")}» de ${by}${p.license ? ` · ${p.licenseUrl ? `<a href="${esc(p.licenseUrl)}">${esc(p.license)}</a>` : esc(p.license)}` : ""}`;
  }
  return `Foto de <a href="${esc(p.authorPage)}">${esc(p.author)}</a> en <a href="https://unsplash.com/?${UTM}">Unsplash</a>`;
};

// --- Guardar en el proyecto ------------------------------------------------------------------------

/** Tipo de imagen según los primeros bytes (no se fía del nombre ni de lo que diga el servidor). */
export function sniffImage(b: Uint8Array): "jpg" | "png" | "gif" | "webp" | undefined {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "png";
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "gif";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return undefined;
}

/** Carpeta relativa y segura dentro del proyecto («assets/images»). Si el ajuste no sirve, la predeterminada. */
export function safeFolder(setting: string): string[] {
  if (/^[/\\~]/.test(setting.trim())) return ["assets", "images"];
  const parts = setting.replace(/\\/g, "/").split("/").map((x) => x.trim()).filter((x) => x && x !== ".");
  const ok = parts.length > 0 && parts.length <= 6 && parts.every((x) => /^[\w][\w .-]{0,60}$/.test(x) && x !== "..");
  return ok ? parts : ["assets", "images"];
}

/** Nombre de archivo legible y seguro: «unsplash-oficina-moderna-abc123.jpg». */
export function imageFileName(p: Photo, ext: string): string {
  const slug = (p.alt || p.title || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40)
    .replace(/-$/, "");
  const id = p.id.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10);
  return `${[p.provider ?? "unsplash", slug, id].filter(Boolean).join("-")}.${ext}`;
}
