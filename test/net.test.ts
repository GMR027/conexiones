import assert from "node:assert/strict";
import * as http from "node:http";
import * as zlib from "node:zlib";
import { after, before, test } from "node:test";
import { DEFAULT_POLICY } from "../src/core/urlPolicy";
import { FetchError, makeLookup, safeFetch } from "../src/net/safeFetch";
import { parseRobots } from "../src/net/robots";

let server: http.Server;
let base = "";
const seen: { url: string; headers: http.IncomingHttpHeaders }[] = [];
const local = { ...DEFAULT_POLICY, allowPrivate: true, allowHttp: true };

before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    const u = req.url ?? "";
    if (u === "/html") return void res.writeHead(200, { "content-type": "text/html; charset=utf-8", etag: '"v1"' }).end("<p>hola</p>");
    if (u === "/cond") return void (req.headers["if-none-match"] === '"v1"' ? res.writeHead(304).end() : res.writeHead(200, { "content-type": "text/plain", etag: '"v1"' }).end("x"));
    if (u === "/gz") return void res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end(zlib.gzipSync("comprimido"));
    if (u === "/bomb") return void res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" }).end(zlib.gzipSync(Buffer.alloc(5 * 1024 * 1024)));
    if (u === "/big") return void res.writeHead(200, { "content-type": "text/plain" }).end("a".repeat(300_000));
    if (u === "/exe") return void res.writeHead(200, { "content-type": "application/octet-stream" }).end("MZ");
    if (u === "/r1") return void res.writeHead(302, { location: "/r2" }).end();
    if (u === "/r2") return void res.writeHead(302, { location: "/html" }).end();
    if (u === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
    if (u === "/to-file") return void res.writeHead(302, { location: "file:///etc/passwd" }).end();
    if (u === "/to-meta") return void res.writeHead(302, { location: "http://169.254.169.254/latest" }).end();
    if (u === "/slow") return;
    if (u === "/404") return void res.writeHead(404).end("no");
    res.writeHead(200, { "content-type": "text/plain" }).end("ok");
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

test("descarga HTML y devuelve texto, encabezados y URL final", async () => {
  const r = await safeFetch(`${base}/html`, { policy: local, accept: ["text/html"] });
  assert.equal(r.text, "<p>hola</p>");
  assert.equal(r.headers.etag, '"v1"');
  assert.equal(r.status, 200);
});

test("peticiones condicionales: 304 no descarga nada", async () => {
  const r = await safeFetch(`${base}/cond`, { policy: local, etag: '"v1"' });
  assert.equal(r.notModified, true);
  assert.equal(r.text, "");
});

test("descomprime gzip y limita lo descomprimido (bomba de compresión)", async () => {
  assert.equal((await safeFetch(`${base}/gz`, { policy: local })).text, "comprimido");
  await assert.rejects(() => safeFetch(`${base}/bomb`, { policy: local, maxBytes: 1024 * 1024 }), (e: FetchError) => e.kind === "too-large");
});

test("rechaza respuestas demasiado grandes y tipos de contenido no permitidos", async () => {
  await assert.rejects(() => safeFetch(`${base}/big`, { policy: local, maxBytes: 100_000 }), (e: FetchError) => e.kind === "too-large");
  await assert.rejects(() => safeFetch(`${base}/exe`, { policy: local, accept: ["text/html", "text/plain"] }), (e: FetchError) => e.kind === "type");
});

test("sigue redirecciones, con límite, y revalida cada destino", async () => {
  assert.equal((await safeFetch(`${base}/r1`, { policy: local })).text, "<p>hola</p>");
  await assert.rejects(() => safeFetch(`${base}/loop`, { policy: local, maxRedirects: 3 }), /redirecciones/);
  await assert.rejects(() => safeFetch(`${base}/to-file`, { policy: local }), (e: FetchError) => e.kind === "blocked");
  const strict = { ...DEFAULT_POLICY, allowHttp: true, allowPrivate: false };
  await assert.rejects(() => safeFetch(`${base}/html`, { policy: strict }), (e: FetchError) => e.kind === "blocked");
});

test("un nombre público que resuelve a una IP interna no llega a conectarse", async () => {
  const strict = { ...DEFAULT_POLICY, allowPrivate: false };
  for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1"]) {
    await assert.rejects(
      () => safeFetch("https://docs.example.org/", { policy: strict, resolver: async () => [{ address, family: address.includes(":") ? 6 : 4 }] }),
      (e: FetchError) => e.kind === "blocked",
      address,
    );
  }
});

test("las claves de API no viajan a otro sitio en una redirección", async () => {
  seen.length = 0;
  const other = http.createServer((req, res) => {
    seen.push({ url: "other" + req.url, headers: req.headers });
    res.writeHead(200, { "content-type": "text/plain" }).end("fin");
  });
  await new Promise<void>((ok) => other.listen(0, "127.0.0.1", ok));
  const otherUrl = `http://127.0.0.1:${(other.address() as { port: number }).port}/dest`;
  const redirecting = http.createServer((_req, res) => res.writeHead(302, { location: otherUrl }).end());
  await new Promise<void>((ok) => redirecting.listen(0, "127.0.0.1", ok));
  try {
    const r = await safeFetch(`http://127.0.0.1:${(redirecting.address() as { port: number }).port}/`, {
      policy: local,
      headers: { authorization: "Bearer SECRETO", "x-ok": "1" },
      sensitiveHeaders: ["authorization"],
    });
    assert.equal(r.text, "fin");
    const got = seen.find((s) => s.url === "other/dest")!;
    assert.equal(got.headers.authorization, undefined);
    assert.equal(got.headers["x-ok"], "1");
  } finally {
    other.closeAllConnections();
    other.close();
    redirecting.closeAllConnections();
    redirecting.close();
  }
});

test("tiempo máximo, 404 y cancelación", async () => {
  await assert.rejects(() => safeFetch(`${base}/slow`, { policy: local, timeoutMs: 200 }), (e: FetchError) => e.kind === "timeout");
  await assert.rejects(() => safeFetch(`${base}/404`, { policy: local }), (e: FetchError) => e.kind === "http" && e.status === 404);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(() => safeFetch(`${base}/html`, { policy: local, signal: ac.signal }), (e: FetchError) => e.kind === "aborted");
});

test("envía un User-Agent propio", async () => {
  seen.length = 0;
  await safeFetch(`${base}/html`, { policy: local });
  assert.match(String(seen[0].headers["user-agent"]), /^Conexiones-VSCode/);
});

test("makeLookup bloquea nombres públicos que resuelven a direcciones privadas (DNS rebinding)", async () => {
  const lookup = (addrs: string[], policy = DEFAULT_POLICY) => new Promise<unknown>((ok) => makeLookup(policy, async () => addrs.map((a) => ({ address: a, family: a.includes(":") ? 6 : 4 })))("x.example", { all: true } as never, (err: unknown, res: unknown) => ok(err ?? res)));
  assert.match(String(await lookup(["127.0.0.1"])), /bloqueada|FetchError/i);
  assert.ok((await lookup(["10.0.0.1"])) instanceof FetchError);
  assert.ok((await lookup(["93.184.216.34", "10.0.0.1"])) instanceof Array, "se queda solo con la pública");
  assert.deepEqual(((await lookup(["93.184.216.34", "10.0.0.1"])) as { address: string }[]).map((a) => a.address), ["93.184.216.34"]);
  assert.ok((await lookup(["10.0.0.1"], { ...DEFAULT_POLICY, allowPrivate: true })) instanceof Array);
  assert.ok((await lookup(["::ffff:169.254.169.254"])) instanceof FetchError);
});

test("parseRobots: la regla más específica gana, comodines, crawl-delay y sitemaps", () => {
  const r = parseRobots(`# x\nUser-agent: *\nDisallow: /private/\nAllow: /private/public/\nDisallow: *.pdf$\nCrawl-delay: 2\nSitemap: https://x.org/sm.xml\n\nUser-agent: otrobot\nDisallow: /`);
  assert.equal(r.allows("/docs/a"), true);
  assert.equal(r.allows("/private/x"), false);
  assert.equal(r.allows("/private/public/x"), true);
  assert.equal(r.allows("/a/b.pdf"), false);
  assert.equal(r.allows("/a/b.pdf?x=1"), true);
  assert.equal(r.crawlDelay, 2);
  assert.deepEqual(r.sitemaps, ["https://x.org/sm.xml"]);
  assert.equal(parseRobots("User-agent: conexiones\nDisallow: /\n\nUser-agent: *\nAllow: /").allows("/a"), false);
  assert.equal(parseRobots("User-agent: *\nDisallow: /").allows("/a"), false);
  assert.equal(parseRobots("").allows("/a"), true);
  assert.equal(parseRobots("User-agent: *\nCrawl-delay: 999").crawlDelay, 10);
});
