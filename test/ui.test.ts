import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { JSDOM } = require("jsdom");

const SCRIPT = readFileSync("media/panel.js", "utf8");
const EVIL = '<img src=x onerror="window.pwned=1"><script>window.pwned=1</script>';

const source = (o: Record<string, unknown> = {}) => ({ id: "src-aaaaaaaa", kind: "docs", adapter: "docs", name: "W3Schools", url: "https://www.w3schools.com/", tags: ["php"], enabled: true, addedAt: 1, lastSync: Date.now() - 60_000, status: "ok", pages: 12, chunks: 80, bytes: 250_000, ttlHours: 24, maxPages: 150, stale: false, ...o });
const TABS = [
  { id: "assistant", label: "Asistente", subtitle: "a" }, { id: "connections", label: "Conexiones", subtitle: "b" }, { id: "library", label: "Biblioteca", subtitle: "c" },
  { id: "resources", label: "Recursos", subtitle: "d" }, { id: "status", label: "Estado", subtitle: "e" }, { id: "settings", label: "Ajustes", subtitle: "f" },
];
const state = (o: Record<string, unknown> = {}) => ({
  version: "0.1.0", tabs: TABS, tab: "assistant", project: "lenguajes: php",
  ai: { mode: "local", ready: true, label: "Local · qwen", problem: undefined, notice: { level: "info", text: "GhostCode ya está cargando un modelo" } },
  sources: [source(), source({ id: "src-bbbbbbbb", kind: "registry", adapter: "packagist", name: "Packagist", url: "https://packagist.org/", status: "pending", lastSync: undefined, stale: false }), source({ id: "src-cccccccc", kind: "icons", adapter: "fontawesome", name: "Font Awesome", chunks: 2000, status: "error", error: "sin red" }), source({ id: "src-dddddddd", kind: "mcp", adapter: "mcp-http", name: "Context7", status: "ok", meta: {} })],
  syncing: { id: "src-aaaaaaaa", done: 3, total: 10, message: "www.w3schools.com/php/" },
  analysis: undefined, analysisError: undefined, asking: false, answer: undefined, pages: [{ sourceId: "src-aaaaaaaa", source: "W3Schools", title: "PHP Intro", url: "https://www.w3schools.com/php/", fetchedAt: Date.now() }],
  libSearch: undefined, pkgSearch: undefined, hasRegistries: true, working: [],
  icons: { available: true, syncing: false, count: 2000, results: undefined },
  fonts: { available: true, syncing: false, count: 1900, categories: ["sans-serif", "serif", "display", "handwriting", "monospace"], results: undefined },
  photos: { available: true, providers: [{ id: "unsplash", label: "Unsplash" }, { id: "openverse", label: "Openverse" }], folder: "assets/images", results: undefined },
  askPhase: "", preview: undefined,
  triconnect: { enabled: false },
  share: { enabled: true, peers: [{ id: "ghostcode", name: "GhostCode", installed: true, linked: true, version: "0.8.1", calls: 3, found: 5 }, { id: "magictools", name: "MagicTools", installed: false, version: "", calls: 0, found: 0 }] },
  kraken: { on: false, running: false, steps: [], resources: { label: "", detail: "" }, connections: [], proposals: [], notes: [] },
  mcp: { manual: [{ id: "src-dddddddd", name: "Context7", url: "https://mcp.context7.com/mcp", status: { state: "active", detail: "Responde correctamente.", ms: 120 } }], configured: [{ key: "f::local", name: "local", origin: "mcp.json", type: "stdio", target: "npx", status: { state: "missing", detail: "Falta configurar: variable X." } }] },
  storage: { path: "/home/u/.config/x", total: 3_000_000, maxMb: 200 },
  settings: { allowHttp: false, allowPrivate: false, allowPrivateNetwork: false, blockedDomains: "malo.com", ttlHours: 24, maxPages: 150, delayMs: 700, maxMb: 200, embeddings: true, embeddingModel: "", language: "auto" },
  embed: { enabled: true, model: "nomic-embed-text", progress: { done: 3, total: 9 } },
  ...o,
});

function boot() {
  const dom = new JSDOM('<!doctype html><body><div id="app"></div></body>', { runScripts: "outside-only", url: "https://x.invalid/" });
  const sent: any[] = [];
  let saved: unknown;
  const w = dom.window as any;
  w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => sent.push(JSON.parse(JSON.stringify(m))), getState: () => saved, setState: (s: unknown) => (saved = s) });
  w.eval(SCRIPT);
  const push = (s: unknown) => w.dispatchEvent(new w.MessageEvent("message", { data: { type: "state", state: s } }));
  const $ = (sel: string) => w.document.querySelector(sel) as HTMLElement | null;
  const $$ = (sel: string) => [...w.document.querySelectorAll(sel)] as HTMLElement[];
  const clickText = (text: string, sel = "button") => {
    const el = $$(sel).find((e) => e.textContent?.trim() === text);
    assert.ok(el, `no hay un botón «${text}»`);
    el!.click();
  };
  const tab = (label: string) => clickText(label, ".tab");
  return { w, sent, push, $, $$, clickText, tab, text: () => w.document.body.textContent as string };
}

test("la vista pide el estado al arrancar y pinta las seis pestañas sin errores", () => {
  const ui = boot();
  assert.deepEqual(ui.sent[0], { type: "ready" });
  ui.push(state());
  for (const label of ["Asistente", "Conexiones", "Biblioteca", "Recursos", "Estado", "Ajustes"]) {
    assert.doesNotThrow(() => ui.tab(label), label);
    assert.ok(ui.$(".tab.on")?.textContent === label);
  }
  assert.equal(ui.$$(".tab").length, 6);
});

test("Conexiones: muestra cada conexión con su estado y los botones de gestión", () => {
  const ui = boot();
  ui.push(state());
  ui.tab("Conexiones");
  const t = ui.text();
  for (const s of ["W3Schools", "Packagist", "Font Awesome", "Context7", "sin red", "Mis conexiones (4)"]) assert.ok(t.includes(s), s);
  assert.ok(ui.$("progress"), "barra de sincronización");
  ui.sent.length = 0;
  const card = ui.$$(".card.source")[0];
  Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Quitar…")!.click();
  assert.deepEqual(ui.sent.at(-1), { type: "remove", id: "src-aaaaaaaa" });
  Array.from(card.querySelectorAll("button")).find((b) => b.textContent === "Vaciar datos")!.click();
  assert.deepEqual(ui.sent.at(-1), { type: "clearData", id: "src-aaaaaaaa" });
});

test("Conexiones: analizar y conectar envían los mensajes correctos y piden la clave cuando hace falta", () => {
  const ui = boot();
  ui.push(state());
  ui.tab("Conexiones");
  const input = ui.$("#url") as HTMLInputElement;
  input.value = "https://unsplash.com/es";
  input.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  ui.clickText("Analizar");
  assert.deepEqual(ui.sent.at(-1), { type: "analyze", url: "https://unsplash.com/es" });
  ui.push(state({ analysis: { ok: true, url: "https://unsplash.com/", kind: "images", adapter: "unsplash", name: "Unsplash", tags: ["images"], warnings: ["aviso de prueba"], summary: "Fotos gratuitas.", key: { label: "Access Key de Unsplash", optional: false } } }));
  assert.ok(ui.text().includes("aviso de prueba"));
  ui.sent.length = 0;
  ui.clickText("Conectar");
  assert.equal(ui.sent.some((m) => m.type === "connect"), false, "sin la clave no se conecta");
  const key = ui.$("#ckey") as HTMLInputElement;
  assert.equal(key.type, "password");
  key.value = "abc123";
  key.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  ui.push(state({ analysis: { ok: true, url: "https://unsplash.com/", kind: "images", adapter: "unsplash", name: "Unsplash", tags: ["images"], warnings: [], summary: "x", key: { label: "Access Key", optional: false } } }));
  (ui.$$("button").find((b) => b.textContent === "Conectar") as HTMLButtonElement).click();
  const msg = ui.sent.find((m) => m.type === "connect");
  assert.deepEqual([msg.url, msg.key], ["https://unsplash.com/", "abc123"]);
});

test("Asistente: la respuesta se pinta con citas, código con botones y fuentes; el HTML malicioso queda como texto", () => {
  const ui = boot();
  const answer = {
    question: "q",
    answer: `## Usa PHPMailer [1]\n\n- Instálalo con **composer** y \`SMTP\`\n\n\`\`\`php\n$m = new PHPMailer();\n\`\`\`\n\nTexto ${EVIL}`,
    sources: [{ n: 1, title: `Doc ${EVIL}`, url: "https://x.org/a", source: `Fuente ${EVIL}` }],
    fragments: [{ title: EVIL, url: "https://x.org/a", heading: EVIL, text: EVIL, source: EVIL, hasCode: false }],
    packages: [{ name: "phpmailer/phpmailer", description: EVIL, url: "https://packagist.org/packages/phpmailer/phpmailer", install: "composer require phpmailer/phpmailer", version: "v7", abandoned: "x/y" }],
    notes: ["1 fragmento omitido"],
  };
  ui.push(state({ answer }));
  assert.equal((ui.w as any).pwned, undefined);
  assert.equal(ui.$$("img").length, 0, "ningún HTML de la respuesta se interpreta");
  assert.equal(ui.$$("script").length, 0);
  assert.ok(ui.$("h4")?.textContent?.includes("Usa PHPMailer"));
  assert.ok(ui.$("sup.cite"));
  assert.ok(ui.$("strong")?.textContent === "composer");
  assert.ok(ui.text().includes("1 fragmento omitido"));
  ui.sent.length = 0;
  ui.clickText("Preview");
  assert.deepEqual(ui.sent.at(-1), { type: "previewCode", code: "$m = new PHPMailer();" });
  ui.$$(".code").find((c) => c.textContent?.includes("$m = new"))!.querySelector("button")!.click();
  assert.deepEqual(ui.sent.at(-1), { type: "copy", text: "$m = new PHPMailer();" });
  ui.$$("button").find((b) => b.textContent === "Copiar comando")!.click();
  assert.deepEqual(ui.sent.at(-1), { type: "copy", text: "composer require phpmailer/phpmailer" });
});

test("Asistente: preguntar con Ctrl+Enter y el botón envía la pregunta; sin conexiones guía al usuario", () => {
  const ui = boot();
  ui.push(state({ sources: [] }));
  assert.ok(ui.text().includes("Aún no hay nada que consultar"));
  const q = ui.$("#q") as HTMLTextAreaElement;
  q.value = "¿cómo envío correos?";
  q.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  q.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }));
  assert.deepEqual(ui.sent.at(-1), { type: "ask", question: "¿cómo envío correos?" });
  ui.clickText("Ir a Conexiones");
  assert.ok(ui.$(".tab.on")?.textContent === "Conexiones");
});

test("Biblioteca: busca, muestra fragmentos y permite guardar paquetes", () => {
  const ui = boot();
  ui.push(state({ libSearch: { query: "correo", fragments: [{ title: "PHP Mail", url: "https://x.org", heading: "H", text: "texto", source: "W3Schools" }] }, pkgSearch: { query: "mailer", items: [{ sourceId: "src-bbbbbbbb", pkg: { name: "phpmailer/phpmailer", description: "d", url: "https://packagist.org/p", install: "composer require phpmailer/phpmailer" } }] } }));
  ui.tab("Biblioteca");
  assert.ok(ui.text().includes("Resultados para «correo»"));
  ui.sent.length = 0;
  ui.clickText("Guardar en mi biblioteca");
  assert.deepEqual(ui.sent.at(-1), { type: "pkgSave", sourceId: "src-bbbbbbbb", name: "phpmailer/phpmailer" });
  assert.ok(ui.text().includes("W3Schools (1)"));
});

test("Recursos: iconos se dibujan como SVG con trazados validados y se copian en varios formatos", () => {
  const ui = boot();
  const hit = (name: string, d: string) => ({ name, label: name, styles: ["solid", "regular"], paths: { solid: { v: [0, 0, 512, 512], d }, regular: { v: [0, 0, 512, 512], d } } });
  ui.push(state({ icons: { available: true, syncing: false, count: 2000, results: { query: "mail", style: "", total: 2000, hits: [hit("envelope", "M48 64C21.5 64z"), hit("evil", 'M0 0"/><script>window.pwned=1</script>')] } } }));
  ui.tab("Recursos");
  const cells = ui.$$(".icon-cell");
  assert.equal(cells.length, 2);
  assert.equal(cells[0].querySelector("svg path")?.getAttribute("d"), "M48 64C21.5 64z");
  assert.equal(cells[1].querySelector("svg path"), null, "un trazado con símbolos raros no se dibuja");
  assert.equal((ui.w as any).pwned, undefined);
  cells[0].click();
  ui.sent.length = 0;
  ui.clickText("Copiar SVG");
  assert.deepEqual(ui.sent.at(-1), { type: "iconCopy", name: "envelope", style: "solid", what: "svg" });
  ui.clickText("Copiar <i>");
  assert.equal(ui.sent.at(-1).what, "html");
  ui.clickText("Línea", ".seg");
  ui.clickText("Copiar clases");
  assert.deepEqual(ui.sent.at(-1), { type: "iconCopy", name: "envelope", style: "regular", what: "class" });
});

test("Recursos: imágenes muestran miniaturas data: y los botones de uso; sin conexión guía al usuario", () => {
  const ui = boot();
  const photo = { id: "abc", alt: EVIL, author: EVIL, color: "#aabbcc", thumb: "data:image/jpeg;base64,/9j/4AAQ", original: "https://images.unsplash.com/full" , regular: "https://images.unsplash.com/r" };
  ui.push(state({ photos: { available: true, providers: [{ id: "unsplash", label: "Unsplash" }], folder: "assets/images", results: { query: "gato", provider: "unsplash", items: [photo], total: 1, remaining: 49 } } }));
  ui.tab("Recursos");
  ui.clickText("Imágenes", ".seg");
  assert.equal(ui.$$("img").length, 1);
  assert.equal(ui.$("img")?.getAttribute("src"), photo.thumb);
  assert.equal((ui.w as any).pwned, undefined);
  assert.ok(ui.text().includes("te quedan 49"));
  ui.sent.length = 0;
  ui.clickText("<img>");
  assert.deepEqual(ui.sent.at(-1), { type: "photoCopy", id: "abc", what: "img" });
  ui.clickText("Crédito");
  assert.equal(ui.sent.at(-1).what, "credit");
  ui.clickText("Guardar en el proyecto");
  assert.deepEqual(ui.sent.at(-1), { type: "photoSave", id: "abc", size: "web" });
  ui.clickText("Original");
  assert.deepEqual(ui.sent.at(-1), { type: "photoSave", id: "abc", size: "original" });
  const none = boot();
  none.push(state({ photos: { available: false, providers: [], results: undefined } }));
  none.tab("Recursos");
  none.clickText("Imágenes", ".seg");
  assert.ok(none.text().includes("Conecta un servicio de imágenes"));
  none.clickText("Conectar Openverse");
  assert.deepEqual(none.sent.at(-1), { type: "quickConnect", what: "openverse" });
  none.clickText("Añadir Pexels");
  assert.deepEqual(none.sent.at(-1), { type: "analyze", url: "https://www.pexels.com/" });
  assert.ok(none.$(".tab.on")?.textContent === "Conexiones");
});

test("Estado: resume conexiones, almacenamiento y MCP con su semáforo", () => {
  const ui = boot();
  ui.push(state());
  ui.tab("Estado");
  const t = ui.text();
  for (const s of ["4 conexión(es)", "Activo", "Falta configurar", "Responde correctamente", "Nunca se ejecuta el programa", "Almacenamiento"]) assert.ok(t.includes(s), s);
  ui.sent.length = 0;
  ui.$$("button").filter((b) => b.textContent === "Comprobar")[1].click();
  assert.deepEqual(ui.sent.at(-1), { type: "mcpCheck", key: "f::local" });
  ui.clickText("Comprobar todos");
  assert.deepEqual(ui.sent.at(-1), { type: "mcpCheckAll" });
});

test("Ajustes: los controles envían el ajuste correcto", () => {
  const ui = boot();
  ui.push(state());
  ui.tab("Ajustes");
  ui.sent.length = 0;
  const boxes = ui.$$("input[type=checkbox]") as HTMLInputElement[];
  boxes[1].checked = true;
  boxes[1].dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  assert.deepEqual(ui.sent.at(-1), { type: "setSetting", key: "security.allowPrivateNetwork", value: true });
  const num = (ui.$$("input[type=number]") as HTMLInputElement[])[1];
  num.value = "300";
  num.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  assert.deepEqual(ui.sent.at(-1), { type: "setSetting", key: "sync.maxPages", value: 300 });
  const ta = ui.$("#blocked") as HTMLTextAreaElement;
  ta.value = "x.com\ny.com";
  ta.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  assert.deepEqual(ui.sent.at(-1), { type: "setSetting", key: "security.blockedDomains", value: "x.com\ny.com" });
  ui.clickText("Borrar todo…");
  assert.deepEqual(ui.sent.at(-1), { type: "clearAll" });
  assert.ok(ui.text().includes("Al quitar una conexión se borra todo lo guardado de ella"));
});

test("el texto escrito se conserva y el foco no se pierde al llegar un estado nuevo", () => {
  const ui = boot();
  ui.push(state());
  const q = ui.$("#q") as HTMLTextAreaElement;
  q.focus();
  q.value = "hola mundo";
  q.dispatchEvent(new ui.w.Event("input", { bubbles: true }));
  ui.push(state({ syncing: { id: "src-aaaaaaaa", done: 5, total: 10, message: "otra" } }));
  const again = ui.$("#q") as HTMLTextAreaElement;
  assert.equal(again.value, "hola mundo");
  assert.equal(ui.w.document.activeElement, again);
});

test("una pestaña pedida desde el editor se abre", () => {
  const ui = boot();
  ui.push(state());
  ui.w.dispatchEvent(new ui.w.MessageEvent("message", { data: { type: "tab", tab: "settings" } }));
  assert.ok(ui.$(".tab.on")?.textContent === "Ajustes");
});

test("el script de la vista no usa innerHTML, eval ni document.write", () => {
  assert.doesNotMatch(SCRIPT, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function/);
});

test("el logo de la cabecera es el indicador: gris en reposo, naranja buscando y verde cuando la respuesta está lista", () => {
  const ui = boot();
  ui.push(state());
  assert.ok(ui.$(".logo-tile.idle"));
  ui.push(state({ asking: true, askPhase: "Leyendo 4 fragmento(s)…" }));
  assert.ok(ui.$(".logo-tile.busy"));
  assert.ok(ui.text().includes("Leyendo 4 fragmento(s)"));
  ui.push(state({ answer: { question: "q", answer: "Hola", sources: [], fragments: [], packages: [], notes: [] } }));
  assert.ok(ui.$(".logo-tile.ready"));
  assert.ok(ui.text().includes("Respuesta lista"));
  assert.ok(ui.$("[role=status]"), "los lectores de pantalla oyen el cambio");
  assert.equal(ui.$(".orb"), null, "ya no hay un indicador aparte");
});

test("la cabecera muestra el logo de Conexiones", () => {
  const ui = boot();
  ui.push(state());
  assert.ok(ui.$(".logo-tile svg.logo circle"));
});

test("Preview: muestra dónde se insertará, avisa de riesgos y solo escribe al confirmar", () => {
  const ui = boot();
  const pv = { canInsert: true, explain: { state: "ready", text: `- Muestra un texto ${EVIL}` }, code: `echo "${EVIL}";`, file: "src/index.php", line: 12, col: 5, replaceLines: 0, before: "<?php\n  ", after: "\n?>", risks: ["Borra archivos"], uri: "file:///x", version: 3, start: 10, end: 10 };
  ui.push(state({ preview: pv }));
  assert.ok(ui.$(".modal [role=dialog]"));
  assert.ok(ui.text().includes("Se insertará en src/index.php, línea 12, columna 5"));
  assert.ok(ui.$(".pv .ins")?.textContent === pv.code);
  assert.ok(ui.text().includes("Qué hace este código"));
  assert.ok(ui.text().includes("Muestra un texto"));
  assert.equal((ui.w as any).pwned, undefined);
  assert.ok(ui.text().includes("Borra archivos"));
  ui.sent.length = 0;
  assert.equal(ui.sent.length, 0, "abrir la vista no manda nada");
  ui.clickText("Insertar aquí");
  assert.deepEqual(ui.sent.at(-1), { type: "confirmInsert" });
  ui.clickText("Cancelar");
  assert.deepEqual(ui.sent.at(-1), { type: "cancelPreview" });
  ui.$(".modal")!.dispatchEvent(new ui.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.deepEqual(ui.sent.at(-1), { type: "cancelPreview" });
  const sel = boot();
  sel.push(state({ preview: { ...pv, replaceLines: 3, stale: true } }));
  assert.ok(sel.text().includes("Reemplazará la selección (3 líneas)"));
  assert.ok(sel.text().includes("El archivo cambió"));
  assert.ok(!sel.$$("button").some((b) => b.textContent === "Insertar aquí"), "con el archivo cambiado no se puede confirmar");
  sel.clickText("Actualizar posición");
  assert.deepEqual(sel.sent.at(-1), { type: "previewCode", code: pv.code });
  assert.equal(boot().$(".modal"), null);
  const loading = boot();
  loading.push(state({ preview: { ...pv, explain: { state: "loading" } } }));
  assert.ok(loading.text().includes("Analizando el código"));
  const noFile = boot();
  noFile.push(state({ preview: { ...pv, canInsert: false, explain: { state: "none" } } }));
  assert.ok(noFile.text().includes("No hay un archivo abierto"));
  assert.ok(noFile.text().includes("No hay una explicación disponible"));
  assert.equal((noFile.$$("button").find((b) => b.textContent === "Insertar aquí") as HTMLButtonElement).disabled, true);
});

test("Recursos: fuentes se buscan por nombre, se pagina de 10 en 10 y se copia o inserta el código de cabecera", () => {
  const ui = boot();
  const hit = (n: number, family = `Fuente ${n}`) => ({ id: `fuente-${n}`, family, category: "sans-serif", weights: [300, 400, 700], italic: true, variable: true });
  const hits = [...Array.from({ length: 9 }, (_v, i) => hit(i + 1)), hit(10, EVIL)];
  ui.push(state({ fonts: { available: true, syncing: false, count: 1900, categories: ["sans-serif"], results: { query: "fuente", category: "", total: 57, page: 2, pages: 6, hits } } }));
  ui.tab("Recursos");
  ui.clickText("Fuentes", ".seg");
  assert.equal(ui.$$(".font-row").length, 10);
  assert.equal((ui.w as any).pwned, undefined);
  assert.ok(ui.text().includes("57 fuente(s) · mostrando 10 en la página 2 de 6"));
  ui.sent.length = 0;
  ui.clickText("3", ".page-btn");
  assert.deepEqual(ui.sent.at(-1), { type: "fontSearch", query: "", category: "", page: 3 });
  ui.clickText("›", ".page-btn");
  assert.equal(ui.sent.at(-1).page, 3);
  ui.clickText("‹", ".page-btn");
  assert.equal(ui.sent.at(-1).page, 1);
  ui.$$(".font-row")[0].click();
  ui.clickText("700", ".chip");
  ui.sent.length = 0;
  ui.$$(".font-act")[0].querySelectorAll("button")[0].click();
  assert.deepEqual(ui.sent.at(-1), { type: "fontCopy", id: "fuente-1", what: "link", weights: [700], italic: false });
  ui.$$(".font-act")[0].querySelectorAll("button")[1].click();
  assert.deepEqual(ui.sent.at(-1), { type: "fontInsert", id: "fuente-1", what: "link", weights: [700], italic: false });
  assert.equal(ui.$$(".font-act")[3].querySelectorAll("button").length, 1, "npm solo se copia");
  const none = boot();
  none.push(state({ fonts: { available: false, syncing: false, count: 0, categories: [], results: undefined } }));
  none.tab("Recursos");
  none.clickText("Fuentes", ".seg");
  none.clickText("Conectar Google Fonts");
  assert.deepEqual(none.sent.at(-1), { type: "quickConnect", what: "googlefonts" });
});

test("Recursos: imágenes con filtros por servicio y paginador", () => {
  const ui = boot();
  const photo = (id: string) => ({ id, alt: "x", author: "a", color: "#aabbcc", regular: "https://x/r", thumb: "data:image/jpeg;base64,/9j/4AAQ" });
  ui.push(state({ photos: { available: true, providers: [{ id: "unsplash", label: "Unsplash" }, { id: "openverse", label: "Openverse" }], folder: "assets/images", results: { query: "gato", provider: "unsplash", items: [photo("a")], total: 120, page: 2, pages: 10, filters: { orientation: "landscape" }, remaining: 40 } } }));
  ui.tab("Recursos");
  ui.clickText("Imágenes", ".seg");
  assert.ok(ui.text().includes("página 2 de 10"));
  assert.equal(ui.$$(".pager").length, 2, "paginador arriba y abajo");
  ui.sent.length = 0;
  ui.$$(".page-btn").find((b) => b.textContent === "3")!.click();
  assert.deepEqual(ui.sent.at(-1), { type: "photoSearch", query: "gato", provider: "unsplash", page: 3, filters: { orientation: "landscape" } });
  assert.ok(ui.$("#fl-color") && ui.$("#fl-order"), "Unsplash filtra por color y orden");
  const sel = ui.$("#fl-orientation") as HTMLSelectElement;
  sel.value = "portrait";
  sel.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  ui.clickText("Openverse", ".seg");
  assert.equal(ui.$("#fl-color"), null, "Openverse no filtra por color");
  assert.ok(ui.$("#fl-category"));
  assert.ok(ui.text().includes("Solo uso comercial"));
});

const kraken = (o: Record<string, unknown> = {}) => ({ on: true, running: false, steps: [{ id: "project", label: "Leer el proyecto completo", state: "done", detail: "40 archivos" }, { id: "plan", label: "Buscar conexiones que te sirven", state: "doing" }, { id: "connect", label: "Conectarlas y leerlas", state: "todo" }, { id: "review", label: "Comparar tu código y proponer mejoras", state: "todo" }], resources: { label: "Local · qwen2.5-coder:14b", detail: "el modelo más grande que cabe" }, connections: [], proposals: [], notes: [], ...o });

test("Modo Kraken: el botón está bajo IA local/API, enciende el efecto y muestra la pantalla informativa", () => {
  const off = boot();
  off.push(state({ kraken: { ...kraken(), on: false } }));
  const btn = off.$(".kraken-btn") as HTMLElement;
  assert.ok(btn.textContent?.includes("Modo Kraken"));
  assert.equal(btn.querySelector("svg"), null, "el botón es solo el botón: sin icono");
  assert.equal(off.$$("svg.kraken-art").length, 0, "apagado se ve el logo de Conexiones");
  assert.ok(off.$(".logo-tile svg.logo"), "logo de Conexiones visible");
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.ok(off.$(".segs")!.compareDocumentPosition(btn) & 4, "va después de los botones IA local / API");
  assert.equal(off.$(".kraken-screen"), null);
  assert.equal(off.w.document.body.classList.contains("kraken"), false);
  btn.click();
  assert.deepEqual(off.sent.at(-1), { type: "krakenToggle", on: true });

  const on = boot();
  on.push(state({ kraken: kraken() }));
  assert.equal(on.w.document.body.classList.contains("kraken"), true, "contorno neón en todo el panel");
  assert.equal(on.$(".kraken-btn")?.getAttribute("aria-pressed"), "true");
  assert.equal(on.$(".k-hero"), null, "la pantalla no lleva un kraken grande");
  assert.equal(on.$$("svg.kraken-art").length, 1, "un solo icono del kraken");
  assert.ok(on.$(".logo-tile.kraken-tile svg.kraken-art .body") && on.$(".logo-tile svg.kraken-art .eyes path"), "el kraken ocupa el sitio del logo, con ojos");
  assert.equal(on.$(".logo-tile svg.logo"), null, "el logo de Conexiones se oculta");
  assert.equal(on.$(".kraken-btn svg"), null, "el botón no lleva icono");
  assert.ok(on.$$("svg.kraken-art").every((s) => s.querySelectorAll("script, foreignObject").length === 0));
  const t = on.$(".kraken-screen")!.textContent!;
  for (const s of ["revisará tu proyecto por completo", "sin que tengas que hacerlo a mano", "Tú apruebas cada una, una por una", "qwen2.5-coder:14b", "40 archivos"]) assert.ok(t.includes(s), s);
  on.sent.length = 0;
  on.$(".kraken-btn")!.click();
  assert.deepEqual(on.sent.at(-1), { type: "krakenToggle", on: false });
  on.clickText("Revisar de nuevo");
  assert.deepEqual(on.sent.at(-1), { type: "krakenScan" });
  on.push(state({ kraken: kraken({ running: true }) }));
  assert.ok(on.$(".logo-tile.busy"), "mientras revisa, el logo está en naranja");
  on.clickText("Detener");
  assert.deepEqual(on.sent.at(-1), { type: "krakenStop" });
  on.push(state({ kraken: { ...kraken(), on: false } }));
  assert.equal(on.w.document.body.classList.contains("kraken"), false, "al apagarlo se quita el efecto");
});

test("Modo Kraken: las refactorizaciones se aprueban una por una y todo el texto de la IA es texto", () => {
  const ui = boot();
  const prop = (id: string, status = "pending") => ({ id, file: "src/a.php", uri: "file:///a", title: `Usar PDO ${EVIL}`, reason: EVIL, source: { title: "PDO", url: "https://php.net/pdo" }, original: `mysql_query("${EVIL}");`, replacement: "$pdo->query($sql);", status });
  ui.push(state({ kraken: kraken({ connections: [{ name: "Manual de PHP", url: "https://www.php.net/manual/en/", why: EVIL, origin: "catálogo", sourceId: "src-aaaaaaaa", status: "ok" }], proposals: [prop("p1"), prop("p2", "applied"), prop("p3", "stale")] }) }));
  assert.equal((ui.w as any).pwned, undefined);
  assert.equal(ui.$$(".k-prop").length, 3);
  assert.equal(ui.$$(".k-diff.del").length, 3);
  assert.ok(ui.text().includes("Refactorizaciones para tu aprobación (1)"));
  assert.ok(ui.text().includes("Conexiones que hizo el Kraken (1)"));
  ui.sent.length = 0;
  ui.clickText("Aprobar y aplicar");
  assert.deepEqual(ui.sent.at(-1), { type: "krakenApprove", id: "p1" });
  assert.equal(ui.$$("button").filter((b) => b.textContent === "Aprobar y aplicar").length, 1, "solo la pendiente se puede aprobar");
  ui.clickText("Ver diff");
  assert.deepEqual(ui.sent.at(-1), { type: "krakenDiff", id: "p1" });
  ui.clickText("Rechazar");
  assert.deepEqual(ui.sent.at(-1), { type: "krakenReject", id: "p1" });
  ui.clickText("Quitar…");
  assert.deepEqual(ui.sent.at(-1), { type: "remove", id: "src-aaaaaaaa" });
});

test("Ajustes: se puede compartir lo guardado con GhostCode y MagicTools y se ve quién lo usa", () => {
  const ui = boot();
  ui.push(state());
  ui.tab("Ajustes");
  const t = ui.text();
  for (const x of ["Compartir con GhostCode y MagicTools", "GhostCode", "3 consulta(s) · 5 fragmento(s)", "No instalada"]) assert.ok(t.includes(x), x);
  ui.sent.length = 0;
  const box = ui.$$("input[type=checkbox]").find((c) => c.closest("label")?.textContent?.includes("otras extensiones")) as HTMLInputElement;
  box.checked = false;
  box.dispatchEvent(new ui.w.Event("change", { bubbles: true }));
  assert.deepEqual(ui.sent.at(-1), { type: "setSetting", key: "share.enabled", value: false });
});

test("el panel nunca escribe «null» ni «undefined» como texto", () => {
  const ui = boot();
  ui.push(state());
  for (const label of ["Asistente", "Conexiones", "Biblioteca", "Recursos", "Estado", "Ajustes"]) {
    ui.tab(label);
    const t = ui.text();
    assert.ok(!/\bnull\b|\bundefined\b|\[object /.test(t), `${label}: ${t.match(/.{0,20}(null|undefined|\[object ).{0,20}/)?.[0]}`);
  }
});

test("Ajustes: el botón Triconnect conecta GhostCode, MagicTools y Conexiones", () => {
  const ui = boot();
  ui.push(state());
  ui.tab("Ajustes");
  const btn = ui.$(".tri-btn") as HTMLElement;
  assert.ok(btn.textContent?.includes("Triconnect"));
  assert.equal(btn.getAttribute("aria-pressed"), "false");
  assert.ok(ui.text().includes("Desconectada"));
  btn.click();
  assert.deepEqual(ui.sent.at(-1), { type: "setSetting", key: "triconnect.enabled", value: true });
  const on = boot();
  on.push(state({ triconnect: { enabled: true } }));
  on.tab("Ajustes");
  assert.equal(on.$(".tri-btn")?.getAttribute("aria-pressed"), "true");
  assert.ok(on.text().includes("Conectada"));
});

test("Modo Kraken: los tentáculos decorativos aparecen al encender y desaparecen al apagar", () => {
  const ui = boot();
  ui.push(state({ kraken: kraken() }));
  const box = ui.w.document.getElementById("kraken-tentacles");
  assert.ok(box && box.querySelectorAll("svg.kt-arm").length >= 4, "tentáculos en los bordes");
  assert.equal(box!.getAttribute("aria-hidden"), "true");
  assert.equal(box!.querySelectorAll("script, foreignObject").length, 0);
  ui.push(state({ kraken: kraken({ on: false }) }));
  assert.equal(ui.w.document.getElementById("kraken-tentacles"), null);
});
