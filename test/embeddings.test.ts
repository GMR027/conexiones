import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { buildVectors, findEmbedModel, semanticSearch } from "../src/embeddings";
import { Library } from "../src/store/library";

let server: http.Server;
let url = "";
const calls: string[][] = [];
const dir = { d: "" };
// «Vectores» falsos: 3 dimensiones según el tema del texto.
const vec = (t: string) => [/correo|email|mail/i.test(t) ? 1 : 0, /color|css/i.test(t) ? 1 : 0, 0.01];
before(async () => {
  dir.d = await mkdtemp(path.join(tmpdir(), "conexiones-e-"));
  server = http.createServer((req, res) => {
    if (req.url === "/api/tags") return void res.end(JSON.stringify({ models: [{ name: "llama3:8b" }, { name: "nomic-embed-text:latest" }] }));
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { input } = JSON.parse(body) as { input: string[] };
      calls.push(input);
      res.end(JSON.stringify({ embeddings: input.map(vec) }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  server.closeAllConnections();
  server.close();
  await rm(dir.d, { recursive: true, force: true });
});

test("findEmbedModel elige el modelo de embeddings instalado", async () => {
  assert.equal(await findEmbedModel(url, ""), "nomic-embed-text:latest");
  assert.equal(await findEmbedModel(url, "nomic-embed-text:latest"), "nomic-embed-text:latest");
  assert.equal(await findEmbedModel(url, "otro"), undefined);
});

test("buildVectors solo calcula lo que falta y semanticSearch encuentra por significado", async () => {
  const lib = new Library(dir.d);
  await lib.init();
  const s = await lib.add({ kind: "docs", adapter: "docs", name: "D", url: "https://d.org/" });
  const ch = (id: string, text: string) => ({ id, url: `https://d.org/${id}`, title: id, heading: "", text, hasCode: false });
  await lib.saveData(s.id, { pages: [], chunks: [ch("a", "Enviar un correo con SMTP"), ch("b", "Cambiar el color con CSS"), { ...ch("c", "correo sospechoso"), flagged: ["x"] }] });
  calls.length = 0;
  assert.equal(await buildVectors(lib, s, url, "nomic-embed-text:latest"), 2, "el sospechoso no se vectoriza");
  assert.equal(calls.flat().length, 2);
  calls.length = 0;
  await buildVectors(lib, s, url, "nomic-embed-text:latest");
  assert.equal(calls.flat().length, 0, "la segunda vez no recalcula");
  const hits = await semanticSearch(lib, "email", url, "nomic-embed-text:latest");
  assert.deepEqual(hits.map((c) => c.id), ["a"]);
  assert.deepEqual(await semanticSearch(lib, "email", url, "otro-modelo"), [], "vectores de otro modelo no se mezclan");
});
