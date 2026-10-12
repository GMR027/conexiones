// Genera el .vsix de la versión actual en releases/ y quita los de versiones anteriores
// (siguen en el historial de Git). Uso: npm run release
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const file = `${pkg.name}-${pkg.version}.vsix`;
const win = process.platform === "win32";

execFileSync("npm", ["run", "package"], { cwd: root, stdio: "inherit", shell: win });
const built = join(root, "dist-vsix", file);
if (!existsSync(built)) throw new Error(`No se generó ${built}`);

// En dist-vsix tampoco se acumulan versiones viejas.
for (const f of readdirSync(join(root, "dist-vsix"))) {
  if (f.startsWith(`${pkg.name}-`) && f.endsWith(".vsix") && f !== file) rmSync(join(root, "dist-vsix", f));
}

const out = join(root, "releases");
mkdirSync(out, { recursive: true });
copyFileSync(built, join(out, file));
for (const f of readdirSync(out)) {
  if (f.startsWith(`${pkg.name}-`) && f.endsWith(".vsix") && f !== file) {
    rmSync(join(out, f));
    console.log(`Quitado: releases/${f}`);
  }
}
console.log(`Listo: releases/${file}\nInstalar: code --install-extension releases/${file}  ·  codium --install-extension releases/${file}`);
