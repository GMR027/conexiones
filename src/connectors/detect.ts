import { checkUrl, type UrlPolicy } from "../core/urlPolicy";
import type { SourceKind } from "../store/library";
import { githubRawUrl } from "./docs";
import { REGISTRIES } from "./registry";

export interface KeyNeed {
  /** Qué clave pedir. */
  label: string;
  optional: boolean;
  /** Encabezado con el que se envía (MCP). */
  header?: string;
}

export type Description =
  | {
      ok: true;
      /** Dirección normalizada (la que se guarda). */
      url: string;
      kind: SourceKind;
      adapter: string;
      name: string;
      tags: string[];
      warnings: string[];
      /** Explicación para mostrar antes de conectar. */
      summary: string;
      key?: KeyNeed;
    }
  | { ok: false; reason: string };

const hostName = (h: string) => h.replace(/^www\./, "");
const pretty = (h: string) => hostName(h).replace(/\.(com|org|net|io|dev|app)$/, "");

/** Sitios cuya dirección «de la web» no es la del servicio MCP. */
const MCP_HOMES: Record<string, { url: string; header: string; name: string }> = {
  "context7.com": { url: "https://mcp.context7.com/mcp", header: "CONTEXT7_API_KEY", name: "Context7" },
};

/** Decide, solo por la dirección (sin red), qué tipo de conexión es y qué se hará con ella. */
export function describeUrl(input: string, policy: UrlPolicy): Description {
  const check = checkUrl(input, policy);
  if (!check.ok) return check;
  const u = check.url;
  const host = hostName(u.hostname.toLowerCase());
  const warnings = [...check.warnings];
  const base = { warnings, tags: [] as string[] };

  for (const reg of Object.values(REGISTRIES)) {
    if (reg.hosts.includes(u.hostname.toLowerCase())) {
      return { ok: true, ...base, tags: reg.tags, url: `https://${reg.hosts[0].replace(/^www\./, "")}/`, kind: "registry", adapter: reg.id, name: reg.label.split(" (")[0], summary: `Registro de paquetes: se buscan paquetes por tema cuando se necesitan y los que uses se guardan en tu equipo.` };
    }
  }
  if (host === "fontawesome.com" || host === "fortawesome.github.io") {
    return { ok: true, ...base, url: "https://fontawesome.com/", kind: "icons", adapter: "fontawesome", name: "Font Awesome", tags: ["icons", "css", "html"], summary: "Biblioteca de iconos. Se descarga la lista de iconos gratuitos (unos 2 000) una vez; los de pago no se incluyen." };
  }
  if (host === "fonts.google.com" || host === "fonts.googleapis.com" || host === "fontsource.org") {
    return { ok: true, ...base, url: "https://fonts.google.com/", kind: "fonts", adapter: "googlefonts", name: "Google Fonts", tags: ["fonts", "css", "html"], summary: "Fuentes gratuitas de Google (unas 1 900). Se descarga la lista una vez; después buscas por nombre o categoría y copias la etiqueta <link>, el @import o el CSS listo." };
  }
  if (host === "pexels.com") {
    return { ok: true, ...base, url: "https://www.pexels.com/", kind: "images", adapter: "pexels", name: "Pexels", tags: ["images"], summary: "Fotos gratuitas. Usa la API oficial de Pexels: necesita tu clave (gratis en pexels.com/api).", key: { label: "API key de Pexels", optional: false } };
  }
  if (host === "openverse.org") {
    return { ok: true, ...base, url: "https://openverse.org/", kind: "images", adapter: "openverse", name: "Openverse", tags: ["images"], summary: "Millones de imágenes con licencia abierta (Flickr, Wikimedia y más). No necesita clave. Cada imagen trae su licencia y su autor." };
  }
  if (host === "unsplash.com") {
    return { ok: true, ...base, url: "https://unsplash.com/", kind: "images", adapter: "unsplash", name: "Unsplash", tags: ["images"], summary: "Fotos gratuitas. Usa la API oficial de Unsplash: necesita tu «Access Key» (gratis en unsplash.com/developers).", key: { label: "Access Key de Unsplash", optional: false } };
  }
  const home = MCP_HOMES[host] ?? MCP_HOMES[host.split(".").slice(-2).join(".")];
  if (home) {
    return { ok: true, ...base, url: home.url, kind: "mcp", adapter: "mcp-http", name: home.name, tags: ["mcp"], summary: `Servidor MCP. Esa es la página de la cuenta; el servicio está en ${home.url}. Se comprueba si está activo y si falta la clave.`, key: { label: `Clave de ${home.name}`, optional: true, header: home.header } };
  }
  if (/^mcp\./.test(host) || /\/(mcp|sse)\/?$/.test(u.pathname)) {
    return { ok: true, ...base, url: u.href, kind: "mcp", adapter: "mcp-http", name: pretty(host), tags: ["mcp"], summary: "Servidor MCP. Se comprueba si está activo y si necesita una clave. No se ejecuta nada en tu equipo.", key: { label: "Clave (si el servidor la pide)", optional: true, header: "Authorization" } };
  }
  if (host === "github.com") {
    const raw = githubRawUrl(u.href);
    if (!raw) return { ok: false, reason: "Para GitHub usa la dirección de un repositorio: github.com/usuario/repositorio." };
    return { ok: true, ...base, url: u.href, kind: "docs", adapter: "github", name: u.pathname.split("/").filter(Boolean).slice(0, 2).join("/"), summary: "Repositorio de GitHub: se guarda su README (documentación de uso)." };
  }
  const single = /\.(md|markdown|txt)$/i.test(u.pathname);
  return {
    ok: true,
    ...base,
    url: u.href,
    kind: "docs",
    adapter: single ? "docs-file" : "docs",
    name: pretty(host),
    summary: single ? "Documento de texto: se guarda su contenido." : `Sitio de documentación o ayuda: se leen las páginas de ${u.pathname === "/" ? "todo el sitio" : "esa carpeta"} (con pausas, respetando robots.txt) y se guardan en tu equipo.`,
  };
}
