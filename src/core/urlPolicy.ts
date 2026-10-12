import { isIP } from "node:net";

/** Reglas que decide el usuario (ajustes) sobre qué direcciones se pueden conectar. */
export interface UrlPolicy {
  /** Permitir http:// (sin cifrar). */
  allowHttp: boolean;
  /** Permitir localhost, IP privadas y puertos no estándar (servidores propios). */
  allowPrivate: boolean;
  /** Dominios bloqueados (y todos sus subdominios). */
  blockedHosts: string[];
}

export const DEFAULT_POLICY: UrlPolicy = { allowHttp: false, allowPrivate: false, blockedHosts: [] };

export type UrlCheck = { ok: true; url: URL; warnings: string[] } | { ok: false; reason: string };

/** Acortadores de enlaces: esconden el destino real. */
const SHORTENERS = new Set(["bit.ly", "t.co", "tinyurl.com", "goo.gl", "is.gd", "ow.ly", "buff.ly", "rebrand.ly", "cutt.ly", "shorturl.at", "t.ly", "rb.gy", "tiny.cc", "lnkd.in", "s.id"]);
/** Nombres que apuntan a la red interna o a servicios de metadatos de la nube. */
const INTERNAL_NAME = /(^|\.)(localhost|local|internal|lan|home|intranet|corp|private|home\.arpa)$/;
const MAX_URL = 2048;

/** Bytes de una IPv6 (16) o undefined si no es válida. */
function ipv6Bytes(ip: string): number[] | undefined {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const p = v4[1].split(".").map(Number);
    if (p.length !== 4 || p.some((n) => n > 255)) return undefined;
    s = s.slice(0, -v4[1].length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (fill < 0 || (halves.length === 1 && head.length !== 8)) return undefined;
  const groups = [...head, ...Array<string>(fill).fill("0"), ...tail];
  if (groups.length !== 8) return undefined;
  const out: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return undefined;
    const n = parseInt(g, 16);
    out.push(n >> 8, n & 255);
  }
  return out;
}

function privateV4(a: number, b: number, c: number): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // enlace local y metadatos de la nube
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224 // multicast, reservadas y broadcast
  );
}

/** true si la IP no es una dirección pública de internet (loopback, red privada, enlace local, metadatos, multicast…). */
export function isPrivateAddress(ip: string): boolean {
  const clean = ip.replace(/^\[|\]$/g, "");
  const kind = isIP(clean);
  if (kind === 4) {
    const [a, b, c] = clean.split(".").map(Number);
    return privateV4(a, b, c);
  }
  if (kind === 6) {
    const b = ipv6Bytes(clean);
    if (!b) return true;
    if (b.slice(0, 15).every((x) => x === 0) && b[15] <= 1) return true; // :: y ::1
    if ((b[0] & 0xfe) === 0xfc) return true; // fc00::/7
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true; // fe80::/10
    if (b[0] === 0xff) return true; // multicast
    if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentación
    const mapped = b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff; // ::ffff:a.b.c.d
    if (mapped) return privateV4(b[12], b[13], b[14]);
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b) return privateV4(b[12], b[13], b[14]); // NAT64
    if (b[0] === 0x20 && b[1] === 0x02) return privateV4(b[2], b[3], b[4]); // 6to4
    return false;
  }
  return true; // lo que no es una IP válida no se considera público
}

const hostMatches = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

/**
 * Filtro de seguridad de toda dirección que se conecta o se visita: solo https, sin credenciales, sin IP ni redes internas,
 * sin acortadores ni puertos raros. El nombre se vuelve a comprobar al conectar (ver net/safeFetch.ts).
 */
export function checkUrl(input: string, policy: UrlPolicy = DEFAULT_POLICY): UrlCheck {
  let text = input.trim();
  if (!text) return { ok: false, reason: "Escribe una dirección." };
  if (text.length > MAX_URL) return { ok: false, reason: "La dirección es demasiado larga." };
  if (/[\s\u0000-\u001f\u007f]/.test(text)) return { ok: false, reason: "La dirección no puede tener espacios ni caracteres de control." };
  // «packagist.org» a secas = https://packagist.org
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text) || /^[\w.-]+:\d+(\/|$)/.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "No es una dirección web válida." };
  }
  const warnings: string[] = [];
  if (url.protocol === "http:") {
    if (!policy.allowHttp && !policy.allowPrivate) return { ok: false, reason: "Solo se admiten direcciones https:// (cifradas). Puedes permitir http en Ajustes." };
    warnings.push("La conexión no está cifrada (http).");
  } else if (url.protocol !== "https:") {
    return { ok: false, reason: `No se admite «${url.protocol}»: solo direcciones web (https).` };
  }
  if (url.username || url.password) return { ok: false, reason: "La dirección no puede llevar usuario ni contraseña." };
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return { ok: false, reason: "Falta el nombre del sitio." };
  if (policy.blockedHosts.some((d) => d && hostMatches(host, d.toLowerCase()))) return { ok: false, reason: `El dominio «${host}» está en tu lista de bloqueados.` };
  if (!policy.allowPrivate) {
    if (isIP(host.replace(/^\[|\]$/g, "")) || host.startsWith("[")) return { ok: false, reason: "No se admiten direcciones IP: usa el nombre del sitio." };
    if (INTERNAL_NAME.test(host) || !host.includes(".")) return { ok: false, reason: "Esa dirección apunta a tu red interna o a tu propio equipo." };
    if (url.port && url.port !== "443" && url.port !== "80") return { ok: false, reason: `Puerto ${url.port} no permitido: solo los puertos web estándar.` };
  } else if (isPrivateAddress(host.replace(/^\[|\]$/g, "")) || INTERNAL_NAME.test(host)) {
    warnings.push("Es una dirección de tu equipo o de tu red local.");
  }
  if (SHORTENERS.has(host)) return { ok: false, reason: "Los acortadores de enlaces esconden el destino real. Usa la dirección completa." };
  if (host.split(".").some((l) => l.startsWith("xn--"))) warnings.push(`El nombre usa caracteres internacionales (${host}): comprueba que sea el sitio que esperas.`);
  if (/\.(zip|mov)$/.test(host)) warnings.push("Esa terminación de dominio se usa a menudo para engaños.");
  return { ok: true, url, warnings };
}

/** Lista de dominios escrita por el usuario (uno por línea o separados por comas) → nombres limpios. */
export function parseHostList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((h) => h.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^\*\./, "")).filter((h) => /^[a-z0-9.-]+$/.test(h)))];
}
