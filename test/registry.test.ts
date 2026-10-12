import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanReply, languageName, resolveLanguage, TABS } from "../src/core/registry";

test("hay seis pestañas con identificadores únicos", () => {
  assert.deepEqual(TABS.map((t) => t.label), ["Asistente", "Conexiones", "Biblioteca", "Recursos", "Estado", "Ajustes"]);
  assert.equal(new Set(TABS.map((t) => t.id)).size, TABS.length);
});

test("resolveLanguage: manda el ajuste, luego el editor y luego el sistema", () => {
  assert.equal(resolveLanguage("fr", "es", {}), "fr");
  assert.equal(resolveLanguage("auto", "es-mx", {}), "es");
  assert.equal(resolveLanguage("auto", "ja", { LANG: "pt_BR.UTF-8" }), "pt");
  assert.equal(resolveLanguage("auto", "ja", {}), "en");
  assert.equal(languageName("de"), "German");
});

test("cleanReply quita la cerca global pero respeta un bloque de código final", () => {
  assert.equal(cleanReply("```markdown\nhola\n```"), "hola");
  assert.equal(cleanReply("```md\n## A\n```js\nx\n```\n```"), "## A\n```js\nx\n```");
  assert.equal(cleanReply("  texto "), "texto");
});
