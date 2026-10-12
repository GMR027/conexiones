// Instala (o desinstala) Conexiones en TODOS los editores compatibles que haya en el equipo:
// VS Code, VS Code Insiders, VSCodium y Code - OSS. El mismo .vsix sirve para todos.
//
//   npm run install:editors                 empaqueta (si hace falta) e instala en todos los que encuentre
//   node scripts/install-editors.mjs --only codium     solo en ese editor
//   node scripts/install-editors.mjs --uninstall       lo quita de todos
//   node scripts/install-editors.mjs --vsix ruta.vsix  usa un .vsix concreto
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const EXT_ID = `${pkg.publisher}.${pkg.name}`;
const EDITORS = ["code", "code-insiders", "codium", "vscodium", "code-oss"];
const win = process.platform === "win32";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

/** Ejecuta `cli ...args` (en Windows los CLI son .cmd y necesitan shell). undefined si falla. */
function run(cli, cliArgs) {
  const r = spawnSync(cli, cliArgs, { encoding: "utf8", shell: win, windowsHide: true });
  return r.status === 0 ? r.stdout : undefined;
}

const available = (cli) => run(cli, ["--version"]) !== undefined;

const only = value("--only");
const editors = (only ? [only] : EDITORS).filter(available);
if (!editors.length) {
  console.error(only ? `No se encontró el editor «${only}» en el PATH.` : "No se encontró ningún editor (code, codium…) en el PATH. En VS Code: «Shell Command: Install 'code' command in PATH».");
  process.exit(1);
}

if (flag("--uninstall")) {
  for (const e of editors) console.log(run(e, ["--uninstall-extension", EXT_ID]) !== undefined ? `✔ Desinstalada de ${e}` : `! No estaba instalada en ${e}`);
  process.exit(0);
}

let vsix = value("--vsix");
if (!vsix) {
  const dir = join(root, "dist-vsix");
  vsix = join(dir, `${pkg.name}-${pkg.version}.vsix`);
  if (!existsSync(vsix)) {
    console.log(`No existe ${vsix}: empaquetando…`);
    execFileSync("npm", ["run", "package"], { cwd: root, stdio: "inherit", shell: win });
  }
  if (!existsSync(vsix) && existsSync(dir)) {
    const latest = readdirSync(dir).filter((f) => f.endsWith(".vsix")).sort().pop();
    if (latest) vsix = join(dir, latest);
  }
}
if (!existsSync(vsix)) {
  console.error(`No se encontró el .vsix (${vsix}). Genéralo con «npm run package».`);
  process.exit(1);
}

console.log(`Paquete: ${vsix}\nEditores: ${editors.join(", ")}`);
let installed = 0;
for (const e of editors) {
  if (run(e, ["--install-extension", vsix, "--force"]) !== undefined) {
    console.log(`✔ Instalada en ${e}`);
    installed++;
  } else console.log(`✘ No se pudo instalar en ${e}. Prueba a mano: ${e} --install-extension "${vsix}"`);
}
console.log(installed ? "Recarga el editor (Developer: Reload Window) para ver los cambios." : "No se instaló en ningún editor.");
process.exit(installed ? 0 : 1);
