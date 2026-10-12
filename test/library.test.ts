import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, test } from "node:test";
import { isSourceId, Library, StoreError } from "../src/store/library";

const dirs: string[] = [];
const fresh = async (max?: number) => {
  const root = await mkdtemp(path.join(tmpdir(), "conexiones-"));
  dirs.push(root);
  const lib = new Library(root, max);
  await lib.init();
  return lib;
};
after(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

const chunk = (id: string, text = "texto") => ({ id, url: "https://x.org/a", title: "T", heading: "H", text, hasCode: false });
const data = (n = 2) => ({ pages: [{ url: "https://x.org/a", title: "T", fetchedAt: 1, hash: "h", chunkIds: ["c0"] }], chunks: Array.from({ length: n }, (_, i) => chunk(`c${i}`)) });

test("añadir, listar, actualizar y persistir las conexiones", async () => {
  const lib = await fresh();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "W3", url: "https://www.w3schools.com/" });
  assert.match(s.id, /^src-[0-9a-f]{8}$/);
  assert.equal(lib.list().length, 1);
  await lib.update(s.id, { enabled: false, tags: ["php"] });
  const again = new Library(lib.root);
  await again.init();
  assert.deepEqual(again.get(s.id)?.tags, ["php"]);
  assert.equal(again.get(s.id)?.enabled, false);
});

test("guardar datos actualiza los contadores y activeChunks respeta enabled y el tipo", async () => {
  const lib = await fresh();
  const a = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  const b = await lib.add({ kind: "icons", adapter: "fontawesome", name: "B", url: "https://b.org/" });
  await lib.saveData(a.id, data(3));
  assert.equal(lib.get(a.id)?.chunks, 3);
  assert.ok(lib.get(a.id)!.bytes > 0);
  assert.equal((await lib.activeChunks()).length, 3);
  await lib.saveData(b.id, data(2));
  assert.equal((await lib.activeChunks()).length, 3, "los iconos no se mezclan con la documentación");
  await lib.update(a.id, { enabled: false });
  assert.equal((await lib.activeChunks()).length, 0);
});

test("QUITAR una conexión borra del disco todo lo que se guardó de ella", async () => {
  const lib = await fresh();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  const keep = await lib.add({ kind: "docs", adapter: "docs", name: "K", url: "https://k.org/" });
  await lib.saveData(s.id, data());
  await lib.writeFile(s.id, "icons.json", { icons: [1, 2, 3] });
  await lib.saveData(keep.id, data());
  const dir = path.join(lib.root, "sources", s.id);
  assert.ok(existsSync(path.join(dir, "pages.json")) && existsSync(path.join(dir, "icons.json")));
  assert.equal(await lib.remove(s.id), true);
  assert.equal(existsSync(dir), false);
  assert.equal(lib.get(s.id), undefined);
  assert.ok(existsSync(path.join(lib.root, "sources", keep.id, "pages.json")), "las demás no se tocan");
  assert.equal((await lib.activeChunks()).length, 2);
  assert.equal(await lib.remove(s.id), false);
  const again = new Library(lib.root);
  await again.init();
  assert.deepEqual(again.list().map((x) => x.id), [keep.id]);
});

test("clearData vacía lo guardado pero mantiene la conexión", async () => {
  const lib = await fresh();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  await lib.saveData(s.id, data(), { status: "ok", lastSync: 5 });
  await lib.clearData(s.id);
  const after = lib.get(s.id)!;
  assert.deepEqual([after.pages, after.chunks, after.bytes, after.status, after.lastSync], [0, 0, 0, "pending", undefined]);
  assert.deepEqual((await lib.data(s.id)).chunks, []);
  assert.equal((await readdir(path.join(lib.root, "sources", s.id))).length, 0);
});

test("clearAll borra todo", async () => {
  const lib = await fresh();
  for (const n of ["A", "B"]) await lib.saveData((await lib.add({ kind: "docs", adapter: "docs", name: n, url: `https://${n}.org/` })).id, data());
  await lib.clearAll();
  assert.equal(lib.list().length, 0);
  assert.equal(await lib.totalBytes(), 0);
});

test("al iniciar se limpian las carpetas huérfanas y las conexiones «sincronizando» vuelven a pendiente", async () => {
  const lib = await fresh();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  await lib.update(s.id, { status: "syncing" });
  await mkdir(path.join(lib.root, "sources", "src-deadbeef"), { recursive: true });
  await writeFile(path.join(lib.root, "sources", "src-deadbeef", "pages.json"), "{}");
  await mkdir(path.join(lib.root, "sources", "cualquier-cosa"), { recursive: true });
  const again = new Library(lib.root);
  await again.init();
  assert.deepEqual(await readdir(path.join(lib.root, "sources")), [s.id]);
  assert.equal(again.get(s.id)?.status, "pending");
});

test("los identificadores y nombres de archivo se validan: no se puede salir de la biblioteca", async () => {
  const lib = await fresh();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  for (const id of ["../../etc", "src-../x", "src-ZZZZZZZZ", "", "src-1234567", "/tmp"]) {
    assert.equal(isSourceId(id), false, id);
    await assert.rejects(() => lib.data(id), StoreError);
    await assert.rejects(() => lib.remove(id).then((r) => r || Promise.reject(new StoreError("no existe"))), StoreError);
  }
  for (const name of ["../x.json", "a/b.json", "x.sh", ".json", "x.json/../../y.json"]) await assert.rejects(() => lib.writeFile(s.id, name, {}), StoreError);
  await assert.rejects(() => lib.readFile(s.id, "../../sources.json", {}), StoreError);
});

test("el límite de espacio se respeta y no deja datos a medias", async () => {
  const lib = await fresh(2000);
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  await assert.rejects(() => lib.saveData(s.id, { pages: [], chunks: Array.from({ length: 50 }, (_, i) => chunk(`c${i}`, "x".repeat(200))) }), /espacio máximo/);
  assert.equal(existsSync(path.join(lib.root, "sources", s.id, "pages.json")), false);
  assert.equal(lib.get(s.id)?.chunks, 0);
});

test("archivos dañados no rompen la carga", async () => {
  const lib = await fresh();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "A", url: "https://a.org/" });
  await writeFile(path.join(lib.root, "sources", s.id, "pages.json"), "{no es json");
  const again = new Library(lib.root);
  await again.init();
  assert.deepEqual((await again.data(s.id)).chunks, []);
  await writeFile(path.join(lib.root, "sources.json"), "basura");
  const third = new Library(lib.root);
  await third.init();
  assert.deepEqual(third.list(), []);
});
