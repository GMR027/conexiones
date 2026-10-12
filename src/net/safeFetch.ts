import * as dns from "node:dns";
import * as http from "node:http";
import * as https from "node:https";
import type { LookupFunction } from "node:net";
import * as zlib from "node:zlib";
import { checkUrl, isPrivateAddress, type UrlPolicy } from "../core/urlPolicy";

export const USER_AGENT = "Conexiones-VSCode/0.2 (lector respetuoso de documentación; extensión de VS Code)";

export class FetchError extends Error {
  constructor(message: string, readonly kind: "blocked" | "network" | "timeout" | "too-large" | "type" | "http" | "aborted" = "network", readonly status?: number) {
    super(message);
  }
}

export interface FetchOptions {
  policy: UrlPolicy;
  method?: "GET" | "POST";
  body?: string;
  headers?: Record<string, string>;
  /** Tipos de contenido que se aceptan (prefijos, p. ej. «text/html»). Otros se rechazan sin leerlos. */
  accept?: string[];
  /** Máximo de bytes del cuerpo (ya descomprimido). */
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  /** Para peticiones condicionales (no se descarga si no cambió). */
  etag?: string;
  lastModified?: string;
  /** Encabezados que NO deben viajar a otro sitio si hay una redirección (claves de API). */
  sensitiveHeaders?: string[];
  /** Sondeo: devuelve el estado y los encabezados sin leer el cuerpo y sin fallar por un código 4xx/5xx. */
  probe?: boolean;
  /** Solo pruebas: sustituye la resolución DNS. */
  resolver?: Resolver;
}

/** Función de descarga que reciben los conectores (con la política y la cancelación ya aplicadas). */
export type FetchFn = (url: string, extra?: Partial<FetchOptions>) => Promise<FetchResult>;

export interface FetchResult {
  /** Dirección final, tras las redirecciones. */
  url: string;
  status: number;
  headers: Record<string, string>;
  /** Cuerpo como texto (vacío si se pidió binario). */
  text: string;
  /** Cuerpo en bytes. */
  bytes: Buffer;
  notModified: boolean;
}

type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });

/**
 * Resolución DNS que rechaza las direcciones no públicas: así un nombre público que apunta a 127.0.0.1 o a 169.254.169.254
 * (DNS rebinding) no llega a conectarse. Se usa en cada conexión, incluidas las de las redirecciones.
 */
export function makeLookup(policy: UrlPolicy, resolver: Resolver = defaultResolver): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, cb: (...args: unknown[]) => void) => {
    resolver(hostname).then(
      (addrs) => {
        const usable = addrs.filter((a) => policy.allowPrivate || !isPrivateAddress(a.address));
        if (!addrs.length || !usable.length) {
          const e = new FetchError(`«${hostname}» apunta a una dirección interna o privada: conexión bloqueada.`, "blocked");
          return options?.all ? cb(e, []) : cb(e, "", 4);
        }
        if (options?.all) return cb(null, usable);
        cb(null, usable[0].address, usable[0].family);
      },
      (err: Error) => cb(err),
    );
  }) as LookupFunction;
}

const REDIRECT = new Set([301, 302, 303, 307, 308]);

function once(url: URL, opts: FetchOptions, headers: Record<string, string>): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      { method: opts.method ?? "GET", headers, lookup: makeLookup(opts.policy, opts.resolver), timeout: opts.timeoutMs ?? 20_000, agent: false },
      (res) => resolve({ res, req }),
    );
    req.on("timeout", () => req.destroy(new FetchError("El sitio tardó demasiado en responder.", "timeout")));
    // Cancelar corta también la espera de la respuesta, no solo la lectura del cuerpo.
    if (opts.signal?.aborted) req.destroy(new FetchError("Cancelado.", "aborted"));
    else opts.signal?.addEventListener("abort", () => req.destroy(new FetchError("Cancelado.", "aborted")), { once: true });
    req.on("error", (e) => reject(e instanceof FetchError ? e : new FetchError(`No se pudo conectar con ${url.hostname} (${(e as NodeJS.ErrnoException).code ?? e.message}).`, "network")));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function readBody(res: http.IncomingMessage, max: number, signal?: AbortSignal): Promise<Buffer> {
  const enc = String(res.headers["content-encoding"] ?? "").toLowerCase();
  let stream: NodeJS.ReadableStream = res;
  // Se mide lo descomprimido: un archivo diminuto que se expande a gigas no pasa.
  if (enc === "gzip" || enc === "x-gzip") stream = res.pipe(zlib.createGunzip());
  else if (enc === "deflate") stream = res.pipe(zlib.createInflate());
  else if (enc === "br") stream = res.pipe(zlib.createBrotliDecompress());
  else if (enc && enc !== "identity") throw new FetchError(`Compresión no admitida (${enc}).`, "type");
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      if (signal?.aborted) throw new FetchError("Cancelado.", "aborted");
      size += chunk.length;
      if (size > max) throw new FetchError(`La respuesta pasa del límite de ${Math.round(max / 1024)} KB.`, "too-large");
      parts.push(chunk);
    }
  } catch (e) {
    res.destroy();
    if (e instanceof FetchError) throw e;
    throw new FetchError("La respuesta llegó dañada.", "network");
  }
  return Buffer.concat(parts);
}

const lower = (h: http.IncomingHttpHeaders): Record<string, string> => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v ?? "")]));

/**
 * Descarga una dirección con todas las protecciones: política de URL en cada salto (redirecciones incluidas),
 * IP real comprobada al conectar, tipos de contenido permitidos, tamaño y tiempo máximos. Nada se guarda ni se ejecuta.
 */
export async function safeFetch(rawUrl: string, opts: FetchOptions): Promise<FetchResult> {
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  let current = rawUrl;
  let origin: string | undefined;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const check = checkUrl(current, opts.policy);
    if (!check.ok) throw new FetchError(check.reason, "blocked");
    const url = check.url;
    if (opts.signal?.aborted) throw new FetchError("Cancelado.", "aborted");
    origin ??= url.origin;
    const headers: Record<string, string> = {
      "user-agent": USER_AGENT,
      "accept-encoding": "gzip, deflate, br",
      accept: opts.accept?.map((a) => `${a};q=0.9`).join(", ") ?? "*/*",
      ...opts.headers,
    };
    if (url.origin !== origin) for (const h of opts.sensitiveHeaders ?? []) delete headers[h.toLowerCase()];
    if (opts.body && !headers["content-type"]) headers["content-type"] = "application/json";
    if (hop === 0 && opts.etag) headers["if-none-match"] = opts.etag;
    if (hop === 0 && opts.lastModified) headers["if-modified-since"] = opts.lastModified;

    const { res, req } = await once(url, opts, headers);
    const abort = () => req.destroy(new FetchError("Cancelado.", "aborted"));
    opts.signal?.addEventListener("abort", abort, { once: true });
    try {
      const status = res.statusCode ?? 0;
      const h = lower(res.headers);
      if (REDIRECT.has(status) && h.location) {
        res.resume();
        try {
          current = new URL(h.location, url).href;
        } catch {
          throw new FetchError("El sitio devolvió una redirección inválida.", "network");
        }
        if (opts.method === "POST" && status !== 307 && status !== 308) opts = { ...opts, method: "GET", body: undefined };
        continue;
      }
      if (opts.probe) {
        res.destroy();
        return { url: url.href, status, headers: h, text: "", bytes: Buffer.alloc(0), notModified: false };
      }
      if (status === 304) {
        res.resume();
        return { url: url.href, status, headers: h, text: "", bytes: Buffer.alloc(0), notModified: true };
      }
      const type = (h["content-type"] ?? "").split(";")[0].trim().toLowerCase();
      if (status >= 200 && status < 300 && opts.accept && type && !opts.accept.some((a) => type === a || type.startsWith(a))) {
        res.resume();
        throw new FetchError(`Tipo de contenido no permitido (${type}).`, "type", status);
      }
      if (Number(h["content-length"]) > maxBytes * 20) {
        res.resume();
        throw new FetchError("La respuesta es demasiado grande.", "too-large", status);
      }
      const bytes = await readBody(res, maxBytes, opts.signal);
      if (status < 200 || status >= 300) throw new FetchError(`El sitio respondió ${status}.`, "http", status);
      const charset = /charset=([\w-]+)/i.exec(h["content-type"] ?? "")?.[1] ?? "utf-8";
      let text: string;
      try {
        text = new TextDecoder(charset).decode(bytes);
      } catch {
        text = new TextDecoder("utf-8").decode(bytes);
      }
      return { url: url.href, status, headers: h, text, bytes, notModified: false };
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
  }
  throw new FetchError(`Demasiadas redirecciones (más de ${maxRedirects}).`, "network");
}
