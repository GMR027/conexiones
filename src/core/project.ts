/** Lo que se sabe del proyecto abierto, para dar prioridad a la documentación que le sirve. */
export interface Stack {
  languages: string[];
  frameworks: string[];
  managers: string[];
}

export const EMPTY_STACK: Stack = { languages: [], frameworks: [], managers: [] };

const NPM_FRAMEWORKS: [RegExp, string][] = [
  [/^react(-dom)?$/, "react"],
  [/^vue$/, "vue"],
  [/^svelte$/, "svelte"],
  [/^next$/, "nextjs"],
  [/^nuxt$/, "nuxt"],
  [/^@angular\/core$/, "angular"],
  [/^express$/, "express"],
  [/^tailwindcss$/, "tailwind"],
  [/^bootstrap$/, "bootstrap"],
  [/^materialize-css$/, "materialize"],
  [/^jquery$/, "jquery"],
  [/^@fortawesome\//, "fontawesome"],
];

function keys(v: unknown): string[] {
  return v && typeof v === "object" ? Object.keys(v as object) : [];
}

/** Detecta el tipo de proyecto a partir de los archivos de la raíz. `files` = nombre → contenido (o "" si solo se sabe que existe). */
export function detectStack(files: Record<string, string>): Stack {
  const languages = new Set<string>();
  const frameworks = new Set<string>();
  const managers = new Set<string>();
  const has = (n: string) => n in files;
  if (has("composer.json")) {
    languages.add("php");
    managers.add("composer");
    try {
      const j = JSON.parse(files["composer.json"] || "{}");
      for (const dep of [...keys(j.require), ...keys(j["require-dev"])]) {
        if (dep === "laravel/framework") frameworks.add("laravel");
        else if (dep.startsWith("symfony/")) frameworks.add("symfony");
        else if (/wordpress|johnpbloch/.test(dep)) frameworks.add("wordpress");
      }
    } catch {
      // composer.json ilegible: se queda en «php»
    }
  }
  if (has("package.json")) {
    languages.add("javascript");
    managers.add("npm");
    try {
      const j = JSON.parse(files["package.json"] || "{}");
      const deps = [...keys(j.dependencies), ...keys(j.devDependencies)];
      if (deps.includes("typescript")) languages.add("typescript");
      for (const d of deps) for (const [re, name] of NPM_FRAMEWORKS) if (re.test(d)) frameworks.add(name);
    } catch {
      // package.json ilegible
    }
  }
  if (has("tsconfig.json")) languages.add("typescript");
  if (has("requirements.txt") || has("pyproject.toml") || has("Pipfile") || has("setup.py")) {
    languages.add("python");
    managers.add("pip");
    const text = `${files["requirements.txt"] ?? ""}\n${files["pyproject.toml"] ?? ""}`.toLowerCase();
    for (const f of ["django", "flask", "fastapi"]) if (new RegExp(`(^|[^a-z])${f}([^a-z]|$)`).test(text)) frameworks.add(f);
  }
  if (has("Cargo.toml")) (languages.add("rust"), managers.add("cargo"));
  if (has("go.mod")) (languages.add("go"), managers.add("go"));
  if (has("pom.xml") || has("build.gradle") || has("build.gradle.kts")) (languages.add("java"), managers.add(has("pom.xml") ? "maven" : "gradle"));
  if (has("Gemfile")) (languages.add("ruby"), managers.add("bundler"));
  if (has("index.html") || has("style.css")) {
    languages.add("html");
    languages.add("css");
  }
  return { languages: [...languages], frameworks: [...frameworks], managers: [...managers] };
}

/** Archivos que se miran en la raíz del proyecto. */
export const STACK_FILES = ["composer.json", "package.json", "tsconfig.json", "requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "Gemfile", "index.html", "style.css"];

/** Etiquetas del proyecto, también con el lenguaje del archivo abierto. */
export function stackTags(stack: Stack, editorLanguage?: string): string[] {
  const tags = new Set([...stack.languages, ...stack.frameworks, ...stack.managers]);
  const map: Record<string, string> = { javascriptreact: "react", typescriptreact: "react", scss: "css", sass: "css", less: "css", php: "php", python: "python", javascript: "javascript", typescript: "typescript", html: "html", css: "css", java: "java", go: "go", rust: "rust", ruby: "ruby" };
  if (editorLanguage && map[editorLanguage]) tags.add(map[editorLanguage]);
  return [...tags];
}

export const describeStack = (s: Stack): string =>
  [s.languages.length && `lenguajes: ${s.languages.join(", ")}`, s.frameworks.length && `frameworks: ${s.frameworks.join(", ")}`, s.managers.length && `gestores: ${s.managers.join(", ")}`].filter(Boolean).join("; ") || "no se pudo detectar";

/** Multiplicador de relevancia de una conexión según cuánto coincide con el proyecto. */
export function tagBoost(sourceTags: readonly string[], projectTags: readonly string[]): number {
  if (!sourceTags.length || !projectTags.length) return 1;
  const hit = sourceTags.filter((t) => projectTags.includes(t)).length;
  return hit ? 1.4 : 0.8;
}
