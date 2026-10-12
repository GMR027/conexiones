import { stripHidden } from "./safety";

/** Bloque de contenido de una página. */
export type Block =
  | { type: "h"; level: number; text: string }
  | { type: "p"; text: string }
  | { type: "li"; text: string }
  | { type: "code"; text: string };

export interface ParsedPage {
  title: string;
  description: string;
  lang: string;
  blocks: Block[];
  /** Enlaces absolutos http(s) de la página (sin repetir). */
  links: string[];
}

const NAMED: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®", hellip: "…", mdash: "—", ndash: "–", laquo: "«", raquo: "»",
  rarr: "→", larr: "←", times: "×", middot: "·", bull: "•", trade: "™", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", eacute: "é", aacute: "á", iacute: "í",
  oacute: "ó", uacute: "ú", ntilde: "ñ", Eacute: "É", Aacute: "Á", Iacute: "Í", Oacute: "Ó", Uacute: "Ú", Ntilde: "Ñ", uuml: "ü", iexcl: "¡", iquest: "¿",
};

/** Convierte &amp; &#39; &#x27;… en texto. */
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
    }
    return NAMED[e] ?? m;
  });
}

const SKIP = new Set(["script", "style", "noscript", "template", "svg", "iframe", "object", "embed", "canvas", "select", "option", "textarea", "head", "form", "button", "dialog", "audio", "video", "map"]);
const CHROME = new Set(["nav", "footer", "aside", "header"]);
/** Clases e ids de bloques que no son contenido: anuncios, menús, avisos de cookies, formularios de reporte, pies de página… (se evalúa palabra por palabra). */
const CHROME_TOKEN = /(?:^|[-_])(?:ads?|adsbygoogle|adcontainer|advert\w*|sidebar|breadcrumbs?|cookies?|cookie\w+|consent\w*|gdpr|banner|popup|modal|newsletter|skyscraper|social|share|feedback|footer\w*|pagetop|navbar|navigation|menu\w*|toc|err(?:or)?[-_]?message|report[-_]?error)(?:$|[-_])|(?:ads|adcontainer|skyscraper|sidebar)$|^[a-z]{0,6}nav(?:_|-|$)/i;
const chromeAttr = (cls: string, id: string): boolean => `${cls} ${id}`.split(/\s+/).some((t) => t && CHROME_TOKEN.test(t));
const BLOCKS = new Set(["p", "div", "section", "article", "main", "ul", "ol", "table", "tr", "dl", "dt", "dd", "blockquote", "hr", "br", "figure", "figcaption", "details", "summary", "address", "fieldset", "li"]);
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

const attrOf = (raw: string, name: string): string | undefined => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i").exec(raw);
  return m ? decodeEntities(m[1] ?? m[2] ?? m[3] ?? "") : undefined;
};

const clean = (s: string) => stripHidden(decodeEntities(s)).replace(/[ \t\r\f\v ]+/g, " ").replace(/ ?\n ?/g, "\n").trim();

/** Parte de la página que contiene el contenido (main o article si existen). */
function mainRegion(html: string): string {
  for (const tag of ["main", "article"]) {
    const open = new RegExp(`<${tag}[\\s>]`, "i").exec(html);
    const close = html.toLowerCase().lastIndexOf(`</${tag}>`);
    if (open && close > open.index) return html.slice(open.index, close + tag.length + 3);
  }
  return html;
}

/**
 * Convierte HTML en bloques de texto (títulos, párrafos, listas, código). Sin dependencias y sin ejecutar nada:
 * descarta scripts, estilos, menús, pies de página y banners, y deja solo texto. Nunca devuelve HTML.
 */
export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const src = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(src)?.[1] ?? "");
  const metaTag = /<meta\b[^>]*\bname\s*=\s*["']description["'][^>]*>/i.exec(src)?.[0] ?? "";
  const description = clean(attrOf(metaTag, "content") ?? "");
  const lang = (attrOf(/<html\b([^>]*)>/i.exec(src)?.[1] ?? "", "lang") ?? "").slice(0, 8);
  const body = mainRegion(/<body[\s>][\s\S]*$/i.exec(src)?.[0] ?? src);

  const blocks: Block[] = [];
  let inline = "";
  let heading = 0;
  const flush = (type: "p" | "li" = "p") => {
    const text = clean(inline).replace(/\n+/g, " ").trim();
    inline = "";
    if (!text) return;
    if (heading) blocks.push({ type: "h", level: heading, text });
    else blocks.push({ type, text });
  };
  let listDepth = 0;
  let skipTag: string | undefined;
  let skipDepth = 0;

  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>|([^<]+|<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[4] !== undefined) {
      if (!skipTag) inline += m[4];
      continue;
    }
    const closing = m[1] === "/";
    const name = m[2].toLowerCase();
    const attrs = m[3] ?? "";
    if (skipTag) {
      if (name === skipTag) {
        if (closing) {
          if (--skipDepth === 0) skipTag = undefined;
        } else if (!VOID.has(name) && !attrs.endsWith("/")) skipDepth++;
      }
      continue;
    }
    if (!closing) {
      const role = attrOf(attrs, "role") ?? "";
      const hidden = /\bhidden\b/i.test(attrs) || attrOf(attrs, "aria-hidden") === "true";
      const chrome = CHROME.has(name) || /navigation|banner|contentinfo|complementary/.test(role) || chromeAttr(attrOf(attrs, "class") ?? "", attrOf(attrs, "id") ?? "");
      if ((SKIP.has(name) || chrome || hidden) && !VOID.has(name)) {
        flush();
        skipTag = name;
        skipDepth = 1;
        continue;
      }
    }
    if (name === "pre") {
      if (closing) continue;
      flush();
      // Todo hasta </pre>, con saltos de línea, sin etiquetas.
      const end = /<\/pre\s*>/gi;
      end.lastIndex = re.lastIndex;
      const close = end.exec(body);
      const raw = body.slice(re.lastIndex, close ? close.index : body.length);
      re.lastIndex = close ? close.index + close[0].length : body.length;
      const code = stripHidden(decodeEntities(raw.replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]*>/g, ""))).replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
      if (code.trim()) blocks.push({ type: "code", text: code });
      continue;
    }
    if (/^h[1-6]$/.test(name)) {
      flush();
      heading = closing ? 0 : Number(name[1]);
      if (closing) heading = 0;
      continue;
    }
    if (name === "code" || name === "kbd" || name === "samp" || name === "tt") {
      inline += "`";
      continue;
    }
    if (name === "a") continue;
    if (name === "img") {
      const alt = attrOf(attrs, "alt");
      if (alt && alt.length < 120) inline += ` ${alt} `;
      continue;
    }
    if (name === "li") {
      flush(listDepth ? "li" : "p");
      if (!closing) inline = "";
      if (closing) continue;
      listDepth ||= 1;
      continue;
    }
    if (name === "ul" || name === "ol") {
      flush(listDepth ? "li" : "p");
      listDepth = closing ? 0 : 1;
      continue;
    }
    if (name === "td" || name === "th") {
      if (closing) inline += " | ";
      continue;
    }
    if (BLOCKS.has(name)) flush(listDepth ? "li" : "p");
  }
  flush();
  return { title, description, lang, blocks: mergeLists(blocks), links: extractLinks(src, baseUrl) };
}

/** Enlaces http(s) de toda la página (también los de menús y barras laterales, que sirven para descubrir páginas aunque no sean contenido). */
export function extractLinks(html: string, baseUrl: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b((?:"[^"]*"|'[^']*'|[^>"'])*)>/gi)) {
    const href = attrOf(m[1], "href")?.trim();
    if (!href || /^(#|javascript:|mailto:|tel:|data:)/i.test(href)) continue;
    try {
      const u = new URL(href, baseUrl);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.hash = "";
        out.add(u.href);
      }
    } catch {
      // enlace mal formado: se ignora
    }
    if (out.size >= 2000) break;
  }
  return [...out];
}

/** Quita bloques repetidos seguidos (menús duplicados, etc.). */
function mergeLists(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    const last = out[out.length - 1];
    if (last && last.type === b.type && last.text === b.text) continue;
    out.push(b);
  }
  return out;
}

/** Los bloques como texto tipo Markdown (para mostrarlo o dárselo a la IA). */
export function blocksToMarkdown(blocks: Block[]): string {
  return blocks
    .map((b) => (b.type === "h" ? `${"#".repeat(Math.min(6, b.level))} ${b.text}` : b.type === "li" ? `- ${b.text}` : b.type === "code" ? "```\n" + b.text + "\n```" : b.text))
    .join("\n\n");
}

/** Documento Markdown/texto plano (README, llms.txt) → bloques. */
export function parseMarkdown(md: string): Block[] {
  const blocks: Block[] = [];
  const lines = stripHidden(md).replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let code: string[] | undefined;
  const flush = () => {
    const text = para.join(" ").replace(/\s+/g, " ").trim();
    if (text) blocks.push({ type: "p", text });
    para = [];
  };
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) {
      if (code) {
        if (code.join("").trim()) blocks.push({ type: "code", text: code.join("\n") });
        code = undefined;
      } else {
        flush();
        code = [];
      }
      continue;
    }
    if (code) {
      code.push(line);
      continue;
    }
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      flush();
      blocks.push({ type: "h", level: h[1].length, text: h[2] });
    } else if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      flush();
      blocks.push({ type: "li", text: line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "").trim() });
    } else if (!line.trim()) flush();
    else para.push(line.trim());
  }
  flush();
  if (code && code.join("").trim()) blocks.push({ type: "code", text: code.join("\n") });
  return blocks.map((b) => (b.type === "code" ? b : { ...b, text: b.text.replace(/<[^>]+>/g, "") })).filter((b) => b.text.trim());
}
