import assert from "node:assert/strict";
import { test } from "node:test";
import { describeUrl } from "../src/connectors/detect";
import { compactFonts, cssFamily, fontSnippet, googleCssUrl, pickWeights, searchFonts } from "../src/connectors/fonts";
import { attributionHtml, imageFileName, imgTag, parseOpenverse, parsePexels, safeFolder, sniffImage, type Photo } from "../src/connectors/images";
import { applyCode, previewContext } from "../src/propose";
import { DEFAULT_POLICY } from "../src/core/urlPolicy";

// --- Fuentes ---------------------------------------------------------------------------------------

const RAW = [
  { id: "open-sans", family: "Open Sans", type: "google", category: "sans-serif", weights: [300, 400, 700, 800], styles: ["italic", "normal"], variable: true },
  { id: "roboto-mono", family: "Roboto Mono", type: "google", category: "monospace", weights: [400, 700], styles: ["normal"], variable: false },
  { id: "bad id", family: "X", type: "google", weights: [400] },
  { id: "evil", family: '<script>alert(1)</script>', type: "google", weights: [400] },
  { id: "notgoogle", family: "Other", type: "other", weights: [400] },
  { id: "noweights", family: "Nada", type: "google", weights: [] },
];

test("compactFonts se queda con las fuentes de Google bien formadas", () => {
  const fonts = compactFonts(RAW);
  assert.deepEqual(fonts.map((f) => f.id), ["open-sans", "roboto-mono"]);
  assert.deepEqual(fonts[0], { id: "open-sans", f: "Open Sans", c: "sans-serif", w: [300, 400, 700, 800], i: true, v: true });
  assert.deepEqual(compactFonts(null), []);
  assert.deepEqual(compactFonts({}), []);
});

test("searchFonts ordena por nombre y filtra por categoría", () => {
  const fonts = compactFonts(RAW);
  assert.deepEqual(searchFonts(fonts, "open").map((f) => f.id), ["open-sans"]);
  assert.deepEqual(searchFonts(fonts, "mono").map((f) => f.id), ["roboto-mono"]);
  assert.deepEqual(searchFonts(fonts, "", "monospace").map((f) => f.id), ["roboto-mono"]);
  assert.deepEqual(searchFonts(fonts, "").length, 2);
  assert.deepEqual(searchFonts(fonts, "zzz"), []);
});

test("los fragmentos de Google Fonts usan solo pesos que existen", () => {
  const [open, mono] = compactFonts(RAW);
  assert.deepEqual(pickWeights(open, []), [400, 700]);
  assert.deepEqual(pickWeights(open, [700, 999, "x", 300, 300]), [300, 700]);
  assert.deepEqual(pickWeights({ ...mono, w: [500] }, []), [500]);
  assert.equal(googleCssUrl(open, [400, 700], false), "https://fonts.googleapis.com/css2?family=Open+Sans:wght@400;700&display=swap");
  assert.equal(googleCssUrl(open, [400], true), "https://fonts.googleapis.com/css2?family=Open+Sans:ital,wght@0,400;1,400&display=swap");
  assert.ok(!googleCssUrl(mono, [400], true).includes("ital"), "sin cursiva disponible no se pide");
  assert.equal(cssFamily(mono), "font-family: 'Roboto Mono', monospace;");
  assert.match(fontSnippet(open, "link", [400], false), /^<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\n<link rel="preconnect" href="https:\/\/fonts\.gstatic\.com" crossorigin>\n<link href="https:\/\/fonts\.googleapis\.com\/css2\?family=Open\+Sans:wght@400&display=swap" rel="stylesheet">$/);
  assert.equal(fontSnippet(open, "import", [400], false), "@import url('https://fonts.googleapis.com/css2?family=Open+Sans:wght@400&display=swap');");
  assert.equal(fontSnippet(open, "npm", [400, 700], false), 'npm install @fontsource/open-sans\n\nimport "@fontsource/open-sans/400.css";\nimport "@fontsource/open-sans/700.css";');
});

// --- Imágenes: Pexels y Openverse --------------------------------------------------------------------

test("parsePexels acepta solo direcciones de Pexels y limpia los textos", () => {
  const photos = parsePexels({
    photos: [
      { id: 7, width: 4000, height: 3000, url: "https://www.pexels.com/photo/x-7/", photographer: "Ana <b>", photographer_url: "https://www.pexels.com/@ana", avg_color: "#112233", alt: 'Un "gato"', src: { large: "https://images.pexels.com/photos/7/l.jpeg", medium: "https://images.pexels.com/photos/7/m.jpeg", original: "https://images.pexels.com/photos/7/o.jpeg" } },
      { id: 8, src: { large: "https://evil.com/l.jpg", medium: "https://images.pexels.com/m.jpg" } },
      { id: 9, src: { large: "https://images.pexels.com.evil.com/l.jpg", medium: "https://images.pexels.com/m.jpg" } },
      { id: "../x", src: { large: "https://images.pexels.com/l.jpg", medium: "https://images.pexels.com/m.jpg" } },
      { id: 10, src: { large: "http://images.pexels.com/l.jpg", medium: "https://images.pexels.com/m.jpg" } },
    ],
  });
  assert.equal(photos.length, 1);
  assert.equal(photos[0].provider, "pexels");
  assert.equal(photos[0].original, "https://images.pexels.com/photos/7/o.jpeg");
  assert.match(attributionHtml(photos[0]), /Pexels<\/a>$/);
  assert.match(imgTag(photos[0]), /alt="Un &quot;gato&quot;"/);
  assert.deepEqual(parsePexels(null), []);
});

test("parseOpenverse exige https, miniatura propia y descarta contenido sensible", () => {
  const ok = { id: "1c5442f6-6bb6-4ab7-b603-f598e7579dd2", title: "Gato <i>feliz</i>", url: "https://live.staticflickr.com/a.jpg", thumbnail: "https://api.openverse.org/v1/images/1c5442f6-6bb6-4ab7-b603-f598e7579dd2/thumb/", creator: "admiller", creator_url: "https://www.flickr.com/photos/1", foreign_landing_url: "https://www.flickr.com/photos/1/2", license: "by", license_version: "2.0", license_url: "https://creativecommons.org/licenses/by/2.0/", width: 700, height: 500 };
  const photos = parseOpenverse({
    results: [
      ok,
      { ...ok, id: "2c5442f6-6bb6-4ab7-b603-f598e7579dd2", url: "http://insegura.example/a.jpg" },
      { ...ok, id: "3c5442f6-6bb6-4ab7-b603-f598e7579dd2", url: "javascript:alert(1)" },
      { ...ok, id: "4c5442f6-6bb6-4ab7-b603-f598e7579dd2", thumbnail: "https://evil.example/t.jpg" },
      { ...ok, id: "5c5442f6-6bb6-4ab7-b603-f598e7579dd2", mature: true },
      { ...ok, id: "../etc/passwd" },
    ],
  });
  assert.equal(photos.length, 1);
  assert.equal(photos[0].license, "CC BY 2.0");
  assert.equal(photos[0].provider, "openverse");
  assert.equal(parseOpenverse({ results: [{ ...ok, license: "cc0", license_version: "1.0" }] })[0].license, "CC0");
  const credit = attributionHtml(photos[0]);
  assert.match(credit, /^«Gato &lt;i&gt;feliz&lt;\/i&gt;» de <a href="https:\/\/www\.flickr\.com\/photos\/1">admiller<\/a> · <a href="https:\/\/creativecommons\.org\/licenses\/by\/2\.0\/">CC BY 2\.0<\/a>$/);
});

// --- Guardar en el proyecto -----------------------------------------------------------------------------

test("sniffImage reconoce el tipo por los bytes y rechaza lo demás (SVG, HTML, ejecutables)", () => {
  const b = (...n: number[]) => Uint8Array.from([...n, ...Array(16).fill(0)]);
  assert.equal(sniffImage(b(0xff, 0xd8, 0xff, 0xe0)), "jpg");
  assert.equal(sniffImage(b(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "png");
  assert.equal(sniffImage(b(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), "gif");
  assert.equal(sniffImage(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0, 0])), "webp");
  assert.equal(sniffImage(new TextEncoder().encode("<svg onload=alert(1)></svg>")), undefined);
  assert.equal(sniffImage(new TextEncoder().encode("<!doctype html><script>")), undefined);
  assert.equal(sniffImage(b(0x4d, 0x5a)), undefined);
  assert.equal(sniffImage(new Uint8Array()), undefined);
});

test("safeFolder no deja salir de la carpeta del proyecto", () => {
  assert.deepEqual(safeFolder("assets/images"), ["assets", "images"]);
  assert.deepEqual(safeFolder("public\\img/"), ["public", "img"]);
  assert.deepEqual(safeFolder("./static/fotos"), ["static", "fotos"]);
  for (const bad of ["", "../fuera", "a/../../b", "/etc", "C:\\Windows", "~/x", "a/b/c/d/e/f/g", "a/.hidden", "x\u0000y", "$(rm -rf)"]) assert.deepEqual(safeFolder(bad), ["assets", "images"], bad);
});

test("imageFileName da nombres legibles y seguros", () => {
  const p = { id: "aB3-xyz/../9", alt: "Oficina Moderna con Árboles & Luz!", provider: "pexels" } as Photo;
  assert.equal(imageFileName(p, "jpg"), "pexels-oficina-moderna-con-arboles-luz-aB3xyz9.jpg");
  assert.equal(imageFileName({ id: "1", alt: "", provider: undefined } as Photo, "png"), "unsplash-1.png");
  assert.ok(!/[\\/:*?"<>|\u0000]/.test(imageFileName({ id: "x", alt: '../../etc/<passwd>:*"', provider: "openverse" } as Photo, "gif")));
  assert.ok(imageFileName({ id: "x", alt: "a".repeat(500), provider: "openverse" } as Photo, "gif").length < 80);
});

// --- Detección de las conexiones nuevas ---------------------------------------------------------------------

test("describeUrl reconoce Google Fonts, Pexels y Openverse", () => {
  const d = (u: string) => {
    const r = describeUrl(u, DEFAULT_POLICY);
    assert.ok(r.ok, u);
    return r.ok ? r : undefined!;
  };
  for (const u of ["https://fonts.google.com/", "https://fonts.google.com/specimen/Roboto", "https://fonts.googleapis.com/css2?family=Roboto"]) {
    assert.deepEqual([d(u).kind, d(u).adapter, d(u).key], ["fonts", "googlefonts", undefined]);
  }
  const px = d("https://www.pexels.com/es-es/");
  assert.deepEqual([px.kind, px.adapter, px.key?.optional], ["images", "pexels", false]);
  const ov = d("https://openverse.org/es");
  assert.deepEqual([ov.kind, ov.adapter, ov.key], ["images", "openverse", undefined]);
  assert.equal(d("https://unsplash.com/es").adapter, "unsplash");
});

// --- Preview de inserción ---------------------------------------------------------------------------------------

test("previewContext muestra hasta 3 líneas antes y después del punto de inserción", () => {
  const text = "uno\ndos\ntres\ncuatro\ncinco\nseis";
  const at = text.indexOf("cuatro") + 3; // "cua|tro"
  assert.deepEqual(previewContext(text, at, at), { before: "dos\ntres\ncua", after: "tro\ncinco\nseis" });
  assert.deepEqual(previewContext("", 0, 0), { before: "", after: "" });
  assert.deepEqual(previewContext("abc", 99, 99), { before: "abc", after: "" });
  assert.equal(previewContext("x".repeat(1000), 800, 800).before.length, 161, "una línea larga se recorta");
  // Con selección, lo seleccionado desaparece de la vista (se reemplaza).
  assert.deepEqual(previewContext("hola mundo cruel", 5, 10), { before: "hola ", after: " cruel" });
  assert.equal(applyCode("hola mundo cruel", 5, 10, "X"), "hola X cruel");
});
