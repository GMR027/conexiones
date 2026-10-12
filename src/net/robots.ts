import { safeFetch, type FetchOptions } from "./safeFetch";

export interface Robots {
  allows(pathAndQuery: string): boolean;
  /** Segundos que pide esperar entre páginas (máx. 10). */
  crawlDelay: number;
  sitemaps: string[];
}

export const ALLOW_ALL: Robots = { allows: () => true, crawlDelay: 0, sitemaps: [] };

const toRegex = (pattern: string): RegExp => new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"));

/** Interpreta un robots.txt para nuestro agente (o «*»): gana la regla más específica (más larga). */
export function parseRobots(text: string, agent = "conexiones"): Robots {
  const groups: { agents: string[]; rules: { allow: boolean; re: RegExp; len: number }[]; delay: number }[] = [];
  const sitemaps: string[] = [];
  let cur: (typeof groups)[number] | undefined;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [], delay: 0 }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap" && /^https?:\/\//i.test(val)) sitemaps.push(val);
    else if (cur && (key === "allow" || key === "disallow") && val) cur.rules.push({ allow: key === "allow", re: toRegex(val), len: val.length });
    else if (cur && key === "crawl-delay") cur.delay = Math.min(10, Math.max(0, Number(val) || 0));
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.includes(a)));
  const chosen = mine.length ? mine : groups.filter((g) => g.agents.includes("*"));
  const rules = chosen.flatMap((g) => g.rules);
  return {
    crawlDelay: chosen.reduce((d, g) => Math.max(d, g.delay), 0),
    sitemaps,
    allows(p) {
      let best: { allow: boolean; len: number } | undefined;
      for (const r of rules) if (r.re.test(p) && (!best || r.len > best.len || (r.len === best.len && r.allow))) best = r;
      return best ? best.allow : true;
    },
  };
}

/** Descarga y lee el robots.txt de un sitio. Si no existe (4xx) todo está permitido; si falla (5xx, red) no se visita nada. */
export async function loadRobots(origin: string, opts: Omit<FetchOptions, "accept" | "maxBytes">): Promise<Robots> {
  try {
    const r = await safeFetch(`${origin}/robots.txt`, { ...opts, accept: ["text/"], maxBytes: 512 * 1024, timeoutMs: 10_000 });
    return parseRobots(r.text);
  } catch (e) {
    const status = (e as { status?: number }).status;
    if (status && status >= 400 && status < 500) return ALLOW_ALL;
    return { allows: () => false, crawlDelay: 0, sitemaps: [] };
  }
}
