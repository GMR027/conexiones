import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { crawlTarget, githubRawUrl, parseSitemap, scopeOf, syncDocs } from "../src/connectors/docs";
import { describeUrl } from "../src/connectors/detect";
import { compactFontAwesome, faHtml, faSvg, searchIcons, type IconRec } from "../src/connectors/icons";
import { attributionHtml, cssBackground, imgTag, parsePhotos } from "../src/connectors/images";
import { findCommand, mcpPolicy, parseMcpConfig, probeHttp, statusStdio } from "../src/connectors/mcp";
import { clearSearchCache, npm, packagist, savePackage, searchRegistry } from "../src/connectors/registry";
import { detectStack, stackTags, tagBoost } from "../src/core/project";
import { DEFAULT_POLICY } from "../src/core/urlPolicy";
import { safeFetch, type FetchFn, type FetchResult } from "../src/net/safeFetch";
import { Library } from "../src/store/library";

const local = { ...DEFAULT_POLICY, allowPrivate: true, allowHttp: true };
const root = { dir: "" };
before(async () => void (root.dir = await mkdtemp(path.join(tmpdir(), "conexiones-c-"))));
after(async () => rm(root.dir, { recursive: true, force: true }));
const newLib = async () => {
  const lib = new Library(await mkdtemp(path.join(root.dir, "lib-")));
  await lib.init();
  return lib;
};

const res = (text: string, headers: Record<string, string> = { "content-type": "application/json" }, url = "https://x.org/"): FetchResult => ({ url, status: 200, headers, text, bytes: Buffer.from(text), notModified: false });
const fake = (routes: Record<string, string | ((url: string, extra?: unknown) => FetchResult)>, calls: string[] = []): FetchFn => async (url, extra) => {
  calls.push(url);
  for (const [k, v] of Object.entries(routes)) if (url.includes(k)) return typeof v === "string" ? res(v, { "content-type": "application/json" }, url) : v(url, extra);
  throw Object.assign(new Error("404"), { kind: "http", status: 404 });
};

// --- Documentación web --------------------------------------------------------------------------

const para = "Este párrafo explica cómo usar la herramienta con bastante detalle para superar el mínimo de texto necesario. ".repeat(3);
const page = (title: string, body: string, links = "") => `<html><head><title>${title}</title></head><body><nav><a href="/menu">menu</a></nav><main><h1>${title}</h1><p>${para}${body}</p>${links}</main></body></html>`;
let server: http.Server;
let base = "";
const hits: string[] = [];
before(async () => {
  server = http.createServer((req, res) => {
    const u = req.url ?? "";
    hits.push(u);
    const html = (b: string) => res.writeHead(200, { "content-type": "text/html", etag: `"${u}"` }).end(b);
    if (u === "/robots.txt") return void res.writeHead(200, { "content-type": "text/plain" }).end("User-agent: *\nDisallow: /docs/privado/\n");
    if (u === "/docs/") return html(page("Inicio", "inicio", `<a href="/docs/a.html">A</a><a href="/docs/b.html">B</a><a href="/docs/privado/x.html">P</a><a href="/otra/c.html">C</a><a href="https://otro.com/z">Z</a><a href="/docs/f.pdf">pdf</a><a href="/docs/a.html?x=1#y">A2</a>`));
    if (u === "/docs/a.html") return req.headers["if-none-match"] === `"${u}"` ? void res.writeHead(304).end() : html(page("Página A", "uso de phpmailer con smtp"));
    if (u === "/docs/b.html") return html(page("Página B", "otra cosa distinta"));
    if (u === "/docs/privado/x.html") return html(page("Privado", "no debe leerse"));
    if (u === "/otra/c.html") return html(page("Fuera", "fuera de la carpeta"));
    if (u === "/docs/exe") return void res.writeHead(200, { "content-type": "application/octet-stream" }).end("MZ");
    res.writeHead(404).end("no");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

const realFetch: FetchFn = (url, extra) => safeFetch(url, { policy: local, ...extra });

test("scopeOf, crawlTarget, parseSitemap y githubRawUrl", () => {
  assert.equal(scopeOf(new URL("https://x.org/docs/")), "/docs/");
  assert.equal(scopeOf(new URL("https://x.org/docs/intro.html")), "/docs/");
  assert.equal(scopeOf(new URL("https://x.org/php")), "/php/");
  assert.equal(scopeOf(new URL("https://x.org/")), "/");
  const start = new URL("https://x.org/docs/");
  assert.equal(crawlTarget("https://x.org/docs/a.html#top", start, "/docs/"), "https://x.org/docs/a.html");
  assert.equal(crawlTarget("https://x.org/docs/a?page=2", start, "/docs/"), "https://x.org/docs/a");
  assert.equal(crawlTarget("https://x.org/otra/a", start, "/docs/"), undefined);
  assert.equal(crawlTarget("http://x.org/docs/a.html", start, "/docs/"), "https://x.org/docs/a.html", "sube a https");
  assert.equal(crawlTarget("http://x.org/docs/a.html", new URL("http://x.org/docs/"), "/docs/"), "http://x.org/docs/a.html", "no baja de https a http ni cambia un sitio http");
  assert.equal(crawlTarget("http://x.org:8080/docs/a.html", start, "/docs/"), undefined);
  assert.equal(crawlTarget("https://otro.com/docs/a", start, "/docs/"), undefined);
  assert.equal(crawlTarget("https://x.org/docs/a.pdf", start, "/docs/"), undefined);
  assert.deepEqual(parseSitemap("<urlset><url><loc>https://x.org/a</loc></url><url><loc> https://x.org/b?x=1&amp;y=2 </loc></url></urlset>").urls, ["https://x.org/a", "https://x.org/b?x=1&y=2"]);
  assert.deepEqual(parseSitemap("<sitemapindex><sitemap><loc>https://x.org/s1.xml</loc></sitemap></sitemapindex>").children, ["https://x.org/s1.xml"]);
  assert.equal(githubRawUrl("https://github.com/PHPMailer/PHPMailer"), "https://raw.githubusercontent.com/PHPMailer/PHPMailer/HEAD/README.md");
  assert.equal(githubRawUrl("https://github.com/o/r.git"), "https://raw.githubusercontent.com/o/r/HEAD/README.md");
  assert.equal(githubRawUrl("https://github.com/o/r/blob/main/docs/guide.md"), "https://raw.githubusercontent.com/o/r/main/docs/guide.md");
  assert.equal(githubRawUrl("https://github.com/o"), undefined);
  assert.equal(githubRawUrl("https://evil.com/o/r"), undefined);
  assert.doesNotMatch(githubRawUrl("https://github.com/o/r/blob/main/../../x.md") ?? "", /\.\./);
  assert.equal(githubRawUrl("https://github.com/o/r/blob/main/%2e%2e/x.md")?.includes("%2e"), false);
});

test("syncDocs rastrea la carpeta, respeta robots.txt y el ámbito, y guarda trozos", async () => {
  const lib = await newLib();
  const src = await lib.add({ kind: "docs", adapter: "docs", name: "Docs", url: `${base}/docs/` });
  hits.length = 0;
  const r = await syncDocs(src, { lib, fetch: realFetch, delayMs: 0, sleep: async () => {} });
  const data = await lib.data(src.id);
  const urls = data.pages.map((p) => new URL(p.url).pathname).sort();
  assert.deepEqual(urls, ["/docs/", "/docs/a.html", "/docs/b.html"]);
  assert.ok(!hits.includes("/docs/privado/x.html"), "robots.txt respetado");
  assert.ok(!hits.includes("/otra/c.html") && !hits.includes("/docs/f.pdf"), "fuera de ámbito / binarios");
  assert.equal(r.fetched, 3);
  assert.ok(data.chunks.length >= 3);
  assert.ok(data.chunks.every((c) => !/menu|<|nav/i.test(c.text.split("\n")[0].slice(0, 5))));
  assert.equal(lib.get(src.id)?.status, "ok");
  assert.equal(lib.get(src.id)?.pages, 3);
  assert.ok(data.pages.find((p) => p.url.endsWith("a.html"))?.etag);
});

test("una segunda sincronización no vuelve a descargar lo que no cambió (ETag)", async () => {
  const lib = await newLib();
  const src = await lib.add({ kind: "docs", adapter: "docs", name: "Docs", url: `${base}/docs/` });
  const ctx = { lib, fetch: realFetch, delayMs: 0, sleep: async () => {} };
  await syncDocs(src, ctx);
  const again = await syncDocs(lib.get(src.id)!, ctx);
  assert.equal(again.unchanged, 1, "a.html responde 304");
  assert.equal(again.pages, 3);
});

test("syncDocs: maxPages, cancelación y errores claros", async () => {
  const lib = await newLib();
  const small = await lib.add({ kind: "docs", adapter: "docs", name: "S", url: `${base}/docs/`, maxPages: 2 });
  assert.equal((await syncDocs(small, { lib, fetch: realFetch, delayMs: 0, sleep: async () => {} })).pages, 2);
  const c = await lib.add({ kind: "docs", adapter: "docs", name: "C", url: `${base}/docs/` });
  const ac = new AbortController();
  ac.abort();
  const cancelled = await syncDocs(c, { lib, fetch: (u, e) => realFetch(u, { ...e, signal: ac.signal }), signal: ac.signal, delayMs: 0, sleep: async () => {} }).catch((e: Error) => e);
  assert.ok(cancelled instanceof Error || (cancelled as { cancelled: boolean }).cancelled);
  const bad = await lib.add({ kind: "docs", adapter: "docs", name: "B", url: `${base}/nada/` });
  await assert.rejects(() => syncDocs(bad, { lib, fetch: realFetch, delayMs: 0, sleep: async () => {} }));
  const priv = await lib.add({ kind: "docs", adapter: "docs", name: "P", url: `${base}/docs/privado/x.html` });
  await assert.rejects(() => syncDocs(priv, { lib, fetch: realFetch, delayMs: 0, sleep: async () => {} }), /robots/);
});

test("syncDocs con la política estricta no puede leer el equipo local", async () => {
  const lib = await newLib();
  const src = await lib.add({ kind: "docs", adapter: "docs", name: "L", url: `${base}/docs/` });
  const strict: FetchFn = (u, e) => safeFetch(u, { policy: DEFAULT_POLICY, ...e });
  await assert.rejects(() => syncDocs(src, { lib, fetch: strict, delayMs: 0, sleep: async () => {} }));
  assert.equal((await lib.data(src.id)).pages.length, 0);
});

test("syncDocs de GitHub guarda el README", async () => {
  const lib = await newLib();
  const src = await lib.add({ kind: "docs", adapter: "github", name: "o/r", url: "https://github.com/o/r" });
  const readme = "# Mi librería\n\n" + "Una librería para enviar correos con SMTP desde PHP de forma sencilla y segura. ".repeat(5) + "\n\n```php\n$m = new Mailer();\n```\n";
  const f: FetchFn = async (url) => (url.endsWith("/robots.txt") ? Promise.reject(Object.assign(new Error("404"), { status: 404, kind: "http" })) : res(readme, { "content-type": "text/plain" }, url));
  await syncDocs(src, { lib, fetch: f, delayMs: 0, sleep: async () => {} });
  const d = await lib.data(src.id);
  assert.equal(d.pages[0].url, "https://raw.githubusercontent.com/o/r/HEAD/README.md");
  assert.ok(d.chunks.some((c) => c.hasCode && /new Mailer/.test(c.text)));
});

// --- Registros de paquetes ----------------------------------------------------------------------

const PACKAGIST_SEARCH = JSON.stringify({ results: [{ name: "phpmailer/phpmailer", description: "PHPMailer is a full-featured email creation and transfer class", url: "x", repository: "https://github.com/PHPMailer/PHPMailer", downloads: 5, favers: 2 }, { name: "bad name!", description: "x" }, { name: "swiftmailer/swiftmailer", description: "old", abandoned: "symfony/mailer" }] });
const PACKAGIST_P2 = JSON.stringify({ packages: { "phpmailer/phpmailer": [{ name: "phpmailer/phpmailer", description: "PHPMailer", version: "v7.1.1", license: ["LGPL-2.1-only"], source: { url: "https://github.com/PHPMailer/PHPMailer.git" }, require: { php: ">=5.5.0" }, keywords: ["mail"] }, { version: "dev-master" }] } });
const README = "# PHPMailer\n\n" + "Envía correos electrónicos con SMTP desde PHP. ".repeat(10) + "\n\n```php\n$mail = new PHPMailer(true);\n```\n";

test("Packagist: busca, descarta nombres inválidos y marca abandonados", async () => {
  const calls: string[] = [];
  const f = fake({ "packagist.org/search.json": PACKAGIST_SEARCH }, calls);
  const pkgs = await packagist.search("mail & co", f);
  assert.deepEqual(pkgs.map((p) => p.name), ["phpmailer/phpmailer", "swiftmailer/swiftmailer"]);
  assert.equal(pkgs[0].install, "composer require phpmailer/phpmailer");
  assert.equal(pkgs[1].abandoned, "symfony/mailer");
  assert.match(calls[0], /q=mail%20%26%20co/);
});

test("Packagist: detalles con README de GitHub", async () => {
  const calls: string[] = [];
  const f = fake({ "repo.packagist.org/p2/phpmailer/phpmailer.json": PACKAGIST_P2, "raw.githubusercontent.com/PHPMailer/PHPMailer/HEAD/README.md": (u) => res(README, { "content-type": "text/plain" }, u) }, calls);
  const { pkg, markdown } = await packagist.details("phpmailer/phpmailer", f);
  assert.equal(pkg.version, "v7.1.1");
  assert.match(markdown, /composer require phpmailer\/phpmailer/);
  assert.match(markdown, /new PHPMailer\(true\)/);
  await assert.rejects(() => packagist.details("../../etc/passwd", f), /no válido/);
  await assert.rejects(() => packagist.details("a/b/c", f), /no válido/);
});

test("npm: busca y valida nombres (incluye paquetes con @alcance)", async () => {
  const f = fake({ "registry.npmjs.org/-/v1/search": JSON.stringify({ objects: [{ package: { name: "nodemailer", description: "Send e-mails", version: "6.9.0", links: { repository: "https://github.com/nodemailer/nodemailer" } }, downloads: { monthly: 9 } }, { package: { name: "../evil" } }, { package: { name: "@scope/pkg", description: "x" } }] }) });
  const pkgs = await npm.search("mail", f);
  assert.deepEqual(pkgs.map((p) => p.name), ["nodemailer", "@scope/pkg"]);
  assert.equal(pkgs[0].install, "npm install nodemailer");
  assert.ok(npm.validName("@scope/pkg") && !npm.validName("UPPER") && !npm.validName("a b") && !npm.validName("../x"));
  const calls: string[] = [];
  await npm.details("@scope/pkg", fake({ "registry.npmjs.org/@scope%2fpkg/latest": JSON.stringify({ name: "@scope/pkg", version: "1.0.0", description: "d", repository: { url: "git+https://github.com/s/p.git" }, license: "MIT" }), "raw.githubusercontent.com/s/p": README }, calls));
  assert.ok(calls.some((c) => c.includes("@scope%2fpkg/latest")));
});

test("searchRegistry guarda en caché; savePackage deja el paquete en la biblioteca (sin duplicar)", async () => {
  clearSearchCache();
  const calls: string[] = [];
  const f = fake({ "packagist.org/search.json": PACKAGIST_SEARCH, "repo.packagist.org/p2/": PACKAGIST_P2, "raw.githubusercontent.com": (u) => res(README, { "content-type": "text/plain" }, u) }, calls);
  await searchRegistry(packagist, "Mailer", f);
  await searchRegistry(packagist, " mailer ", f);
  assert.equal(calls.filter((c) => c.includes("search.json")).length, 1);
  const lib = await newLib();
  const src = await lib.add({ kind: "registry", adapter: "packagist", name: "Packagist", url: "https://packagist.org/", tags: ["php"] });
  await savePackage(lib, src, packagist, "phpmailer/phpmailer", f);
  await savePackage(lib, src, packagist, "phpmailer/phpmailer", f);
  const d = await lib.data(src.id);
  assert.equal(d.pages.length, 1);
  assert.ok(d.chunks.length >= 1 && d.chunks.some((c) => /composer require/.test(c.text)));
  assert.equal(lib.get(src.id)?.status, "ok");
});

// --- Iconos --------------------------------------------------------------------------------------

const FA = {
  envelope: { label: "Envelope", search: { terms: ["email", "mail", "letter"] }, svg: { solid: { viewBox: [0, 0, 512, 512], path: "M48 64C21.5 64z" }, regular: { viewBox: [0, 0, 512, 512], path: "M64 112z" } } },
  "envelope-open": { label: "Envelope Open", search: { terms: ["email"] }, svg: { solid: { viewBox: [0, 0, 512, 512], path: "M0 0z" } } },
  github: { label: "GitHub", search: { terms: ["octocat"] }, svg: { brands: { viewBox: [0, 0, 496, 512], path: "M1 2z" } } },
  "../evil": { label: "x", svg: { solid: { viewBox: [0, 0, 1, 1], path: "M0 0" } } },
  inyeccion: { label: "x", svg: { solid: { viewBox: [0, 0, 1, 1], path: 'M0 0"/><script>alert(1)</script>' } } },
  badbox: { label: "x", svg: { solid: { viewBox: ["a", 0, 1, 1], path: "M0 0" } } },
};

test("Font Awesome: se compacta descartando lo inseguro y se busca por nombre, términos y estilo", () => {
  const icons = compactFontAwesome(FA);
  assert.deepEqual(icons.map((i) => i.n).sort(), ["envelope", "envelope-open", "github"]);
  assert.equal(searchIcons(icons, "envelope")[0].name, "envelope");
  assert.deepEqual(searchIcons(icons, "email").map((i) => i.name).sort(), ["envelope", "envelope-open"]);
  assert.deepEqual(searchIcons(icons, "", "brands").map((i) => i.name), ["github"]);
  assert.deepEqual(searchIcons(icons, "zzz"), []);
  assert.deepEqual(searchIcons(icons, "envelope")[0].styles, ["solid", "regular"]);
  assert.equal(searchIcons(icons, "", undefined, 1).length, 1);
  assert.deepEqual(compactFontAwesome(null), []);
});

test("Font Awesome: HTML y SVG autónomo con aviso de licencia", () => {
  const icon = compactFontAwesome(FA).find((i) => i.n === "envelope") as IconRec;
  assert.equal(faHtml("envelope", "solid"), '<i class="fa-solid fa-envelope"></i>');
  const svg = faSvg(icon, "solid")!;
  assert.match(svg, /<svg [^>]*viewBox="0 0 512 512"[^>]*><path d="M48 64C21\.5 64z"\/><\/svg>/);
  assert.match(svg, /Font Awesome Free/);
  assert.equal(faSvg(icon, "brands"), undefined);
});

// --- Imágenes ------------------------------------------------------------------------------------

test("Unsplash: solo se aceptan direcciones de Unsplash y los fragmentos HTML salen escapados", () => {
  const photos = parsePhotos({
    results: [
      { id: "abc", alt_description: 'Un "gato" <b>feliz</b>', width: 4000, height: 3000, color: "#aabbcc", urls: { regular: "https://images.unsplash.com/photo-1?w=1080", small: "https://images.unsplash.com/photo-1?w=400" }, links: { html: "https://unsplash.com/photos/abc", download_location: "https://api.unsplash.com/photos/abc/download" }, user: { name: "Ana <script>", links: { html: "https://unsplash.com/@ana" } } },
      { id: "mal", urls: { regular: "https://evil.com/x.jpg", small: "https://images.unsplash.com/s" }, links: { download_location: "https://api.unsplash.com/d" } },
      { id: "js", urls: { regular: "javascript:alert(1)", small: "https://images.unsplash.com/s" }, links: { download_location: "https://api.unsplash.com/d" } },
      { id: "host1", urls: { regular: "https://imagesunsplash.com/a", small: "https://images.unsplash.com/s" }, links: { download_location: "https://api.unsplash.com/d" } },
      { id: "host2", urls: { regular: "https://images.unsplash.com.evil.com/a", small: "https://images.unsplash.com/s" }, links: { download_location: "https://api.unsplash.com/d" } },
      { id: "host3", urls: { regular: "http://images.unsplash.com/a", small: "https://images.unsplash.com/s" }, links: { download_location: "https://api.unsplash.com/d" } },
      { id: "../x", urls: { regular: "https://images.unsplash.com/a", small: "https://images.unsplash.com/s" }, links: { download_location: "https://api.unsplash.com/d" } },
    ],
  });
  assert.equal(photos.length, 1);
  const p = photos[0];
  assert.match(imgTag(p), /^<img src="https:\/\/images\.unsplash\.com\/photo-1\?w=1080" alt="Un &quot;gato&quot; &lt;b&gt;feliz&lt;\/b&gt;" width="4000" loading="lazy">$/);
  assert.match(cssBackground(p), /background-image: url\("https:\/\/images\.unsplash\.com/);
  assert.match(attributionHtml(p), /Ana &lt;script&gt;.*utm_source=conexiones.*Unsplash/s);
  assert.deepEqual(parsePhotos(null), []);
});

// --- MCP -----------------------------------------------------------------------------------------

test("parseMcpConfig entiende los formatos de VS Code y de Claude y detecta lo que falta", () => {
  const vs = parseMcpConfig(`// comentario\n{"servers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp","headers":{"CONTEXT7_API_KEY":"\${input:ctx7}"}},"local":{"command":"npx","args":["-y","@x/server"],"env":{"TOKEN":"\${env:MI_TOKEN}"}},"vacio":{}}}`, ".vscode/mcp.json", {});
  assert.deepEqual(vs.map((s) => [s.name, s.type]), [["context7", "http"], ["local", "stdio"], ["vacio", "unknown"]]);
  assert.deepEqual(vs[0].missing, ["entrada «ctx7»"]);
  assert.deepEqual(vs[1].missing, ["variable MI_TOKEN"]);
  assert.deepEqual(parseMcpConfig(`{"mcpServers":{"a":{"url":"https://x.org/sse","type":"sse"}}}`, ".mcp.json")[0].type, "sse");
  assert.deepEqual(parseMcpConfig(`{"servers":{"l":{"command":"x","env":{"T":"\${env:HOME}"}}}}`, "f", { HOME: "/h" })[0].missing, []);
  assert.deepEqual(parseMcpConfig("no es json", "f"), []);
  assert.deepEqual(parseMcpConfig("{}", "f"), []);
});

test("el estado de un MCP por comando solo mira el disco y nunca ejecuta nada", () => {
  const [s] = parseMcpConfig(`{"servers":{"a":{"command":"npx"}}}`, "f");
  const exists = (p: string) => p === "/usr/bin/npx";
  assert.equal(findCommand("npx", ["/bin", "/usr/bin"], exists), "/usr/bin/npx");
  assert.equal(findCommand("nope", ["/usr/bin"], exists), undefined);
  assert.equal(findCommand("/usr/bin/npx", [], exists), "/usr/bin/npx");
  assert.equal(statusStdio(s, "/usr/bin/npx").state, "ready");
  assert.equal(statusStdio(s, undefined).state, "inactive");
  assert.equal(statusStdio({ ...s, missing: ["variable X"] }, "/usr/bin/npx").state, "missing");
});

test("probeHttp distingue activo, falta clave, ruta incorrecta e inactivo", async () => {
  const mk = (status: number, type = "application/json") => (async () => ({ ...res("", { "content-type": type }), status })) as unknown as FetchFn;
  assert.equal((await probeHttp("https://m.org/mcp", {}, mk(200, "text/event-stream"), DEFAULT_POLICY)).state, "active");
  assert.equal((await probeHttp("https://m.org/mcp", {}, mk(401), DEFAULT_POLICY)).state, "auth");
  assert.match((await probeHttp("https://m.org/mcp", {}, mk(403), DEFAULT_POLICY)).detail, /no hay ninguna/);
  assert.match((await probeHttp("https://m.org/mcp", { k: "v" }, mk(403), DEFAULT_POLICY)).detail, /rechazó la clave/);
  assert.equal((await probeHttp("https://m.org/mcp", {}, mk(404), DEFAULT_POLICY)).state, "not-mcp");
  assert.equal((await probeHttp("https://m.org/", {}, mk(200, "text/html"), DEFAULT_POLICY)).state, "not-mcp");
  assert.equal((await probeHttp("https://m.org/mcp", {}, mk(500), DEFAULT_POLICY)).state, "inactive");
  const down: FetchFn = async () => Promise.reject(Object.assign(new Error("No se pudo conectar"), { kind: "network" }));
  assert.equal((await probeHttp("https://m.org/mcp", {}, down, DEFAULT_POLICY)).state, "inactive");
  const blocked: FetchFn = async () => Promise.reject(Object.assign(new Error("bloqueado"), { kind: "blocked" }));
  assert.equal((await probeHttp("https://m.org/mcp", {}, blocked, DEFAULT_POLICY)).state, "blocked");
});

test("mcpPolicy solo abre tu propio equipo (loopback), no cualquier red privada", () => {
  assert.equal(mcpPolicy(DEFAULT_POLICY, "http://localhost:3000/mcp").allowPrivate, true);
  assert.equal(mcpPolicy(DEFAULT_POLICY, "http://127.0.0.1:8080/mcp").allowPrivate, true);
  assert.equal(mcpPolicy(DEFAULT_POLICY, "http://169.254.169.254/x").allowPrivate, false);
  assert.equal(mcpPolicy(DEFAULT_POLICY, "http://192.168.1.5/mcp").allowPrivate, false);
  assert.equal(mcpPolicy(DEFAULT_POLICY, "https://mcp.context7.com/mcp").allowPrivate, false);
});

// --- Detección de tipo de conexión ---------------------------------------------------------------

test("describeUrl reconoce el tipo de cada ejemplo", () => {
  const d = (u: string) => {
    const r = describeUrl(u, DEFAULT_POLICY);
    assert.ok(r.ok, u + (r.ok ? "" : r.reason));
    return r.ok ? r : undefined!;
  };
  assert.deepEqual([d("https://packagist.org/").kind, d("https://packagist.org/").adapter, d("https://packagist.org/").tags], ["registry", "packagist", ["php", "composer"]]);
  assert.equal(d("https://www.npmjs.com/package/x").adapter, "npm");
  assert.equal(d("https://materializecss.com/").kind, "docs");
  assert.equal(d("https://www.w3schools.com/").name, "w3schools");
  assert.equal(d("https://fontawesome.com/").adapter, "fontawesome");
  const un = d("https://unsplash.com/es");
  assert.deepEqual([un.kind, un.key?.optional], ["images", false]);
  const c7 = d("https://context7.com/sign-in?redirect_url=https%3A%2F%2Fcontext7.com%2Fdashboard");
  assert.deepEqual([c7.kind, c7.url, c7.key?.header], ["mcp", "https://mcp.context7.com/mcp", "CONTEXT7_API_KEY"]);
  assert.equal(d("https://mcp.ejemplo.dev/").kind, "mcp");
  assert.equal(d("https://ejemplo.dev/api/mcp").kind, "mcp");
  assert.equal(d("https://github.com/PHPMailer/PHPMailer").adapter, "github");
  assert.equal(d("https://example.org/README.md").adapter, "docs-file");
  assert.equal(d("https://example.org/docs/").adapter, "docs");
  assert.ok(!describeUrl("https://github.com/PHPMailer", DEFAULT_POLICY).ok);
  assert.ok(!describeUrl("file:///etc/passwd", DEFAULT_POLICY).ok);
  assert.ok(!describeUrl("http://localhost:3000", DEFAULT_POLICY).ok);
});

// --- Proyecto ------------------------------------------------------------------------------------

test("detectStack y stackTags", () => {
  const s = detectStack({ "composer.json": '{"require":{"laravel/framework":"^11","symfony/mailer":"*"}}', "package.json": '{"devDependencies":{"typescript":"5","tailwindcss":"3"},"dependencies":{"react":"18","@fortawesome/fontawesome-free":"6"}}', "requirements.txt": "Django==5\nrequests" });
  assert.deepEqual(s.languages.sort(), ["javascript", "php", "python", "typescript"]);
  assert.deepEqual(s.frameworks.sort(), ["django", "fontawesome", "laravel", "react", "symfony", "tailwind"]);
  assert.deepEqual(detectStack({}), { languages: [], frameworks: [], managers: [] });
  assert.doesNotThrow(() => detectStack({ "composer.json": "{no", "package.json": "" }));
  assert.ok(stackTags(detectStack({}), "scss").includes("css"));
  assert.equal(tagBoost(["php"], ["php", "laravel"]), 1.4);
  assert.equal(tagBoost(["php"], ["python"]), 0.8);
  assert.equal(tagBoost([], ["python"]), 1);
});
