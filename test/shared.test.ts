import assert from "node:assert/strict";
import { test } from "node:test";
import { isCompletionOnly, pickChatModel, resolveLocalModel, type GhostInfo } from "../src/core/shared";

const ghost: GhostInfo = { mode: "local", model: "qwen2.5-coder:1.5b-base", chatModel: "" };
const installed = ["qwen2.5-coder:1.5b-base", "qwen2.5-coder:1.5b", "llama3.2:3b", "nomic-embed-text"];

test("isCompletionOnly distingue modelos base de modelos de chat", () => {
  assert.equal(isCompletionOnly("qwen2.5-coder:1.5b-base"), true);
  assert.equal(isCompletionOnly("starcoder2:3b"), true);
  assert.equal(isCompletionOnly("qwen2.5-coder:1.5b"), false);
});

test("pickChatModel prefiere la variante instruct del modelo de autocompletado y evita embeddings", () => {
  assert.equal(pickChatModel(installed, "qwen2.5-coder:1.5b-base"), "qwen2.5-coder:1.5b");
  assert.equal(pickChatModel(["nomic-embed-text", "qwen2.5-coder:1.5b-base"], ""), undefined);
});

test("si hay un modelo de chat ya cargado, se reutiliza y se avisa de que GhostCode lo carga", () => {
  const r = resolveLocalModel({ loaded: ["llama3.2:3b"], installed, ghost, ownChatModel: "" });
  assert.equal(r.model, "llama3.2:3b");
  assert.equal(r.alreadyLoaded, true);
  assert.match(r.notice!.text, /GhostCode ya está cargando un modelo \(llama3\.2:3b\)/);
});

test("sin GhostCode en modo local el aviso habla de Ollama", () => {
  const r = resolveLocalModel({ loaded: ["llama3.2:3b"], installed, ghost: undefined, ownChatModel: "" });
  assert.match(r.notice!.text, /^Ollama ya está cargando/);
});

test("si solo está cargado el modelo base de GhostCode, usa su variante de chat y avisa de los dos modelos", () => {
  const r = resolveLocalModel({ loaded: ["qwen2.5-coder:1.5b-base"], installed, ghost, ownChatModel: "" });
  assert.equal(r.model, "qwen2.5-coder:1.5b");
  assert.equal(r.alreadyLoaded, false);
  assert.equal(r.notice!.level, "warn");
  assert.match(r.notice!.text, /dos modelos/);
});

test("el modelo de chat configurado en GhostCode tiene prioridad sobre el automático", () => {
  const r = resolveLocalModel({ loaded: [], installed, ghost: { ...ghost, chatModel: "llama3.2:3b" }, ownChatModel: "" });
  assert.equal(r.model, "llama3.2:3b");
});

test("solo hay modelos base: no hay modelo y se avisa", () => {
  const r = resolveLocalModel({ loaded: ["qwen2.5-coder:1.5b-base"], installed: ["qwen2.5-coder:1.5b-base"], ghost, ownChatModel: "" });
  assert.equal(r.model, undefined);
  assert.equal(r.notice!.level, "warn");
});

test("Ollama sin respuesta: no se decide nada", () => {
  const r = resolveLocalModel({ loaded: undefined, installed: undefined, ghost, ownChatModel: "" });
  assert.equal(r.model, undefined);
  assert.equal(r.notice, undefined);
});
