import * as os from "node:os";
import * as vscode from "vscode";
import { AnthropicBackend } from "./backends/anthropic";
import { OllamaBackend } from "./backends/ollama";
import { describeUrl } from "./connectors/detect";
import { parseHtml } from "./core/html";
import { cfg, createApiBackend, defaultApiModel, getApiKey, PROVIDER_LABELS, settings, urlPolicy } from "./config";
import { candidatesFor, extractTerms, offStackFramework, isSensitivePath, KRAKEN_API_MODEL, parseProposals, parseRecommendations, pickLocalModel, pickSampleFiles, recommendationsRequest, redactSecrets, refactorRequest, summarizeProject, tuneLocal, type Candidate, type ProjectFile } from "./core/kraken";
import { detectStack, describeStack, STACK_FILES, stackTags, tagBoost, type Stack } from "./core/project";
import { resolveLanguage } from "./core/registry";
import { riskyCode } from "./core/safety";
import { SearchIndex } from "./core/search";
import { BackendError, type Backend, type ChatRequest } from "./core/types";
import { inspectLocal } from "./localGuard";
import { safeFetch } from "./net/safeFetch";
import { showDiff } from "./propose";
import type { Library } from "./store/library";
import { boundFetch } from "./sync";

export const KRAKEN_STATE_KEY = "conexiones.kraken.on";
/** Conexiones que el Kraken está creando y aún no terminan: si el editor se cierra a la mitad, se borran al volver. */
export const KRAKEN_PENDING_KEY = "conexiones.kraken.pending";
const EXCLUDE = "{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/vendor/**,**/.venv/**,**/venv/**,**/__pycache__/**,**/target/**,**/.next/**,**/coverage/**,**/*.lock,**/*.min.*}";
const MAX_CONNECTIONS = 8;
const MAX_PROPOSALS = 8;
/** Páginas que lee el Kraken por sitio (suficiente para que el asistente cite) y tiempo máximo total de la fase de conexión: así la revisión llega al código en minutos, no en media hora. */
const KRAKEN_PAGES = 25;
const CONNECT_BUDGET_MS = 4 * 60_000;

type StepState = "todo" | "doing" | "done" | "skipped" | "error";
interface Step {
  id: "project" | "plan" | "connect" | "review";
  label: string;
  state: StepState;
  detail?: string;
}

export interface KrakenProposal {
  id: string;
  file: string;
  uri: string;
  title: string;
  reason: string;
  source?: { title: string; url: string };
  original: string;
  replacement: string;
  status: "pending" | "applied" | "stale";
}

interface KrakenConnection {
  name: string;
  url: string;
  why: string;
  origin: "catálogo" | "IA";
  sourceId?: string;
  status: "ok" | "error" | "pending";
  error?: string;
}

export interface KrakenHost {
  readonly lib: Library;
  readonly secrets: vscode.SecretStorage;
  readonly state: vscode.Memento;
  readonly log: vscode.LogOutputChannel;
  changed(): void;
  /** Sincroniza una conexión y espera a que termine. */
  syncRun(id: string): Promise<void>;
  /** Cancela la sincronización en curso si es de esta conexión. */
  syncCancel(id: string): void;
  /** Quita una conexión y todo lo guardado de ella (datos, clave y cachés). */
  discard(id: string): Promise<void>;
  aiReady(): Promise<boolean>;
  targetEditor(): vscode.TextEditor | undefined;
}

const initialSteps = (): Step[] => [
  { id: "project", label: "Leer el proyecto completo", state: "todo" },
  { id: "plan", label: "Buscar conexiones que te sirven", state: "todo" },
  { id: "connect", label: "Conectarlas y leerlas", state: "todo" },
  { id: "review", label: "Comparar tu código y proponer mejoras", state: "todo" },
];

/** Si el mejor modelo no existe para esa cuenta, se usa el que el usuario tenía configurado. */
class FallbackBackend implements Backend {
  readonly id: string;
  readonly label: string;
  constructor(private readonly primary: Backend, private readonly secondary: Backend) {
    this.id = primary.id;
    this.label = primary.label;
  }
  async *chat(req: ChatRequest, signal: AbortSignal): AsyncIterable<string> {
    let started = false;
    try {
      for await (const piece of this.primary.chat(req, signal)) {
        started = true;
        yield piece;
      }
    } catch (e) {
      if (started || !(e instanceof BackendError) || e.kind !== "model") throw e;
      yield* this.secondary.chat(req, signal);
    }
  }
}

/**
 * Modo Kraken: la IA activa revisa el proyecto, conecta por sí sola las webs que le sirven y propone refactorizaciones
 * apoyadas en lo que leyó. Cada cambio de código lo aprueba el usuario uno por uno; nada se escribe sin su clic.
 */
export class Kraken {
  on: boolean;
  running = false;
  private steps = initialSteps();
  private notes: string[] = [];
  private error?: string;
  private connections: KrakenConnection[] = [];
  private proposals: KrakenProposal[] = [];
  private resources = { label: "", detail: "" };
  private abort?: AbortController;
  private seq = 0;
  private current?: Promise<void>;
  lastRun?: number;

  constructor(private readonly host: KrakenHost) {
    this.on = host.state.get<boolean>(KRAKEN_STATE_KEY, false);
  }

  // --- Encender y apagar --------------------------------------------------------------------------------

  async setOn(on: boolean): Promise<void> {
    if (on === this.on) return;
    if (on && cfg().mode === "api") {
      const label = PROVIDER_LABELS[cfg().apiProvider];
      const ok = await vscode.window.showWarningMessage(`El Modo Kraken enviará a ${label} un resumen de tu proyecto (nombres de archivos, dependencias y fragmentos de código sin claves).`, { modal: true, detail: "Usará el mejor modelo disponible y puede gastar más créditos de tu API. Puedes apagarlo cuando quieras." }, "Activar Kraken");
      if (ok !== "Activar Kraken") return;
    }
    this.on = on;
    await this.host.state.update(KRAKEN_STATE_KEY, on);
    if (!on) {
      this.stop();
      await this.current;
      this.proposals = [];
      this.connections = [];
      this.steps = initialSteps();
      this.notes = [];
      this.error = undefined;
      this.host.changed();
      return;
    }
    this.host.changed();
    void this.scan();
  }

  stop(): void {
    this.abort?.abort();
    for (const c of this.connections) if (c.sourceId && c.status === "pending") this.host.syncCancel(c.sourceId);
  }

  /** Ids de conexiones a medio crear (se guardan para limpiarlas aunque el editor se cierre). */
  private async track(id: string, on: boolean): Promise<void> {
    const list = new Set(this.host.state.get<string[]>(KRAKEN_PENDING_KEY, []));
    on ? list.add(id) : list.delete(id);
    await this.host.state.update(KRAKEN_PENDING_KEY, [...list]);
  }

  /** Al arrancar: borra lo que quedó a medias si el editor se cerró durante una revisión. */
  async recover(): Promise<number> {
    let n = 0;
    for (const id of this.host.state.get<string[]>(KRAKEN_PENDING_KEY, [])) {
      const s = this.host.lib.get(id);
      if (s && s.status !== "ok") (await this.host.discard(id), n++);
    }
    await this.host.state.update(KRAKEN_PENDING_KEY, []);
    return n;
  }

  /** Quita las conexiones de esta revisión que no llegaron a terminar de leerse (nada incompleto ni corrupto). */
  private async discardIncomplete(): Promise<void> {
    const dropped: string[] = [];
    for (const c of this.connections) {
      if (!c.sourceId || c.status === "ok") continue;
      await this.host.discard(c.sourceId);
      await this.track(c.sourceId, false);
      dropped.push(c.name);
    }
    this.connections = this.connections.filter((c) => c.status === "ok");
    if (dropped.length) this.notes.push(`Se quitaron ${dropped.length} conexión(es) que no llegaron a terminar: ${dropped.join(", ")}.`);
  }

  // --- Recursos: el mejor modelo y todo el equipo -------------------------------------------------------------------

  /** Backend con lo mejor disponible: el modelo local más grande que cabe y todo el hardware, o el mejor modelo de la API. */
  async backend(): Promise<{ backend: Backend; budget: number; label: string } | undefined> {
    const c = cfg();
    if (c.mode === "api") {
      const base = await createApiBackend(this.host.secrets).catch(() => undefined);
      if (!base) return undefined;
      const best = KRAKEN_API_MODEL[c.apiProvider];
      let backend: Backend = base;
      let model = c.apiModel || defaultApiModel(c.apiProvider) || (c.apiProvider === "opencode" ? "predeterminado de OpenCode" : "el modelo configurado");
      if (c.apiProvider === "anthropic") {
        const key = await getApiKey(this.host.secrets, "anthropic");
        const mk = (m: string) => new AnthropicBackend(key, m, c.apiBaseUrl || undefined, "high");
        const configured = c.apiModel || defaultApiModel("anthropic");
        backend = best && best !== configured ? new FallbackBackend(mk(best), mk(configured)) : mk(configured);
        model = best ?? configured;
      }
      const label = `${PROVIDER_LABELS[c.apiProvider]} · ${model}`;
      this.resources = { label, detail: c.apiProvider === "anthropic" ? "mejor modelo de la API con razonamiento alto" : c.apiProvider === "codestral" ? "mejor modelo de Codestral" : "el modelo que configuraste (no puedo saber cuál es el mejor de tu proveedor)" };
      return { backend, budget: 100_000, label };
    }
    const local = await inspectLocal();
    if (!local.reachable) return void (this.resources = { label: "Ollama no responde", detail: `Inícialo en ${local.url}` });
    const models = await OllamaBackend.listModels(local.url).catch(() => []);
    const mem = os.totalmem();
    const model = pickLocalModel(models, mem, local.model);
    if (!model) return void (this.resources = { label: "Sin modelo de chat", detail: "Descarga uno en Ollama" });
    const tuning = tuneLocal(mem, os.cpus().length || 4);
    const gb = Math.round(mem / 2 ** 30);
    const label = `Local · ${model}`;
    this.resources = { label, detail: `el modelo más grande que cabe en tus ${gb} GB de RAM · contexto de ${tuning.numCtx.toLocaleString("es")} · GPU con todas las capas posibles · ${tuning.numThread} hilos · modelo siempre cargado` };
    return { backend: new OllamaBackend(local.url, model, tuning), budget: Math.floor(tuning.numCtx * 2.2), label };
  }

  async refreshResources(): Promise<void> {
    if (this.on && !this.running) await this.backend().catch(() => undefined);
  }

  // --- La revisión ------------------------------------------------------------------------------------------------------

  private step(id: Step["id"], state: StepState, detail?: string): void {
    const s = this.steps.find((x) => x.id === id)!;
    s.state = state;
    s.detail = detail;
    this.host.changed();
  }

  private link(ms: number): { signal: AbortSignal; done(): void } {
    const ac = new AbortController();
    const kill = () => ac.abort();
    this.abort?.signal.addEventListener("abort", kill, { once: true });
    const timer = setTimeout(kill, ms);
    return { signal: ac.signal, done: () => (clearTimeout(timer), this.abort?.signal.removeEventListener("abort", kill)) };
  }

  private async chat(backend: Backend, req: ChatRequest, ms: number): Promise<string | undefined> {
    const l = this.link(ms);
    try {
      let out = "";
      for await (const piece of backend.chat(req, l.signal)) out += piece;
      return out;
    } catch (e) {
      if (this.abort?.signal.aborted) throw e;
      this.notes.push(`La IA no pudo responder: ${(e as Error).message}`);
      return undefined;
    } finally {
      l.done();
    }
  }

  scan(): Promise<void> {
    if (this.running || !this.on) return this.current ?? Promise.resolve();
    this.current = this.run();
    return this.current;
  }

  private async run(): Promise<void> {
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    this.steps = initialSteps();
    this.notes = [];
    this.error = undefined;
    this.connections = [];
    this.proposals = [];
    this.host.changed();
    try {
      // Con varias carpetas abiertas se revisa la del archivo que tienes a la vista (o la primera).
      const open = vscode.window.activeTextEditor?.document.uri;
      const folder = (open && vscode.workspace.getWorkspaceFolder(open)) || vscode.workspace.workspaceFolders?.[0];
      if (!folder || !vscode.workspace.isTrusted) throw new Error("Abre una carpeta de proyecto (de confianza) para que el Kraken pueda revisarla.");
      const ai = (await this.host.aiReady()) ? await this.backend() : undefined;
      if (!ai) this.notes.push("La IA no está lista: el Kraken solo usará su catálogo para conectar y no podrá proponer refactorizaciones.");
      const budget = ai?.budget ?? 16_000;
      const lang = resolveLanguage(cfg().language, vscode.env.language, process.env);

      // 1) El proyecto
      this.step("project", "doing", "Listando archivos…");
      const { files, stack, manifests } = await this.readProject(folder);
      if (signal.aborted) throw new Error("cancelado");
      const samplePaths = pickSampleFiles(files, ai && ai.budget > 40_000 ? 10 : 6);
      const samples: { path: string; text: string }[] = [];
      for (const f of samplePaths) {
        const text = await this.readText(vscode.Uri.joinPath(folder.uri, ...f.path.split("/")));
        if (text) samples.push({ path: f.path, text });
      }
      const summary = summarizeProject({ stack: describeStack(stack), files, manifests, samples, budget });
      this.step("project", "done", `${files.length} archivos · ${describeStack(stack)}`);

      // 2) Qué conectar
      this.step("plan", "doing");
      const connected = this.host.lib.list().map((s) => s.url);
      const editorLang = vscode.window.activeTextEditor?.document.languageId;
      const picks: { c: Candidate; origin: KrakenConnection["origin"] }[] = candidatesFor(stack, [...(editorLang ? stackTags(stack, editorLang).filter((t) => !stackTags(stack).includes(t)) : [])]).slice(0, 6).map((c) => ({ c, origin: "catálogo" as const }));
      if (ai && !signal.aborted) {
        const raw = await this.chat(ai.backend, recommendationsRequest(summary, connected, lang), 180_000);
        for (const r of raw ? parseRecommendations(raw) : []) picks.push({ c: { name: r.name, url: r.url, why: r.why, tags: r.tags }, origin: "IA" });
      }
      const accepted = await this.vet(picks, connected, stack);
      this.step("plan", "done", accepted.length ? `${accepted.length} recomendada(s)` : "Nada nuevo que conectar");

      // 3) Conectar
      this.step("connect", accepted.length ? "doing" : "skipped", accepted.length ? `0/${accepted.length}` : "Ya tienes lo esencial conectado");
      let n = 0;
      const began = Date.now();
      for (const a of accepted) {
        if (signal.aborted) break;
        if (Date.now() - began > CONNECT_BUDGET_MS) {
          this.notes.push(`Para no hacerte esperar, dejé sin conectar ${accepted.length - n} sitio(s) más; puedes añadirlos tú en «Conexiones».`);
          break;
        }
        n++;
        this.step("connect", "doing", `${n}/${accepted.length} · ${a.name}`);
        const s = await this.host.lib.add({ kind: a.kind, adapter: a.adapter, name: a.name, url: a.url, tags: a.tags, ttlHours: settings().ttlHours, maxPages: Math.min(settings().maxPages, KRAKEN_PAGES) });
        await this.track(s.id, true);
        const conn: KrakenConnection = { name: a.name, url: a.url, why: a.why, origin: a.origin, sourceId: s.id, status: "pending" };
        this.connections.push(conn);
        await this.host.syncRun(s.id).catch(() => undefined);
        const after = this.host.lib.get(s.id);
        conn.status = after?.status === "ok" && !signal.aborted ? "ok" : "error";
        conn.error = after?.error;
        if (conn.status === "ok") await this.track(s.id, false);
        this.host.changed();
      }
      if (signal.aborted) throw new Error("cancelado");
      if (accepted.length) this.step("connect", "done", `${this.connections.filter((c) => c.status === "ok").length}/${accepted.length} conectadas`);

      // 4) Refactorizaciones
      if (!ai) this.step("review", "skipped", "Necesita la IA");
      else await this.review(ai, folder, samplePaths, stack, lang);
      this.lastRun = Date.now();
    } catch (e) {
      const cancelled = signal.aborted;
      this.error = cancelled ? undefined : (e as Error).message;
      for (const s of this.steps) if (s.state === "doing") s.state = cancelled ? "skipped" : "error";
      if (cancelled) this.notes.push("Revisión detenida.");
      this.host.log.warn(`Kraken: ${(e as Error).message}`);
      await this.discardIncomplete();
    } finally {
      this.running = false;
      this.host.changed();
    }
  }

  /** Comprueba cada recomendación: https, dentro de la política, sin claves, que exista y que no esté ya conectada. */
  private async vet(picks: { c: Candidate; origin: KrakenConnection["origin"] }[], connected: string[], stack: Stack) {
    const out: { name: string; url: string; kind: NonNullable<ReturnType<typeof describeOk>>["kind"]; adapter: string; tags: string[]; why: string; origin: KrakenConnection["origin"] }[] = [];
    const seen = new Set(connected);
    // Dos recomendaciones del mismo sitio (p. ej. «PHP» y «Manual de PHP», o un sitio y una carpeta suya) no se conectan dos veces;
    // carpetas distintas del mismo dominio (MDN · HTML y MDN · CSS) sí.
    const place = (u: string, adapter?: string, kind?: string): { host: string; path: string } => {
      try {
        if (kind === "registry" || kind === "icons" || kind === "fonts" || kind === "images") return { host: `${kind}:${adapter}`, path: "/" };
        const p = new URL(u);
        return { host: p.host.replace(/^www\./, ""), path: p.pathname.replace(/\/+$/, "") + "/" };
      } catch {
        return { host: u, path: "/" };
      }
    };
    const placed = connected.map((u) => place(u));
    const taken = (x: { host: string; path: string }) => placed.some((y) => y.host === x.host && (x.path.startsWith(y.path) || y.path.startsWith(x.path)));
    for (const { c, origin } of picks) {
      if (out.length >= MAX_CONNECTIONS || this.abort?.signal.aborted) break;
      const d = describeOk(c.url);
      if (!d) {
        this.notes.push(`Descartada «${c.name}»: la dirección no pasa el filtro de seguridad.`);
        continue;
      }
      if (seen.has(d.url) || taken(place(d.url, d.adapter, d.kind))) continue;
      const off = origin === "IA" ? offStackFramework(d.url, stack) : undefined;
      if (off) {
        this.notes.push(`Descartada «${c.name}»: tu proyecto no parece usar ${off}.`);
        continue;
      }
      if (d.kind === "mcp") {
        this.notes.push(`«${c.name}» es un servidor MCP: el Kraken no los conecta solo. Añádelo tú si quieres.`);
        continue;
      }
      if (d.key && !d.key.optional) {
        this.notes.push(`«${d.name}» necesita una clave: añádela tú en «Conexiones».`);
        continue;
      }
      if (d.kind === "docs" && d.adapter !== "github") {
        try {
          const r = await safeFetch(d.url, { policy: urlPolicy(), accept: ["text/html", "text/plain", "text/markdown"], maxBytes: 1.5 * 1024 * 1024, timeoutMs: 15_000, signal: this.abort?.signal });
          if (r.headers["content-type"]?.includes("html") && !parseHtml(r.text, r.url).blocks.length) throw new Error("sin texto");
        } catch {
          this.notes.push(`Descartada «${c.name}»: no se pudo abrir ${d.url}.`);
          continue;
        }
      }
      seen.add(d.url);
      placed.push(place(d.url, d.adapter, d.kind));
      out.push({ name: c.name || d.name, url: d.url, kind: d.kind, adapter: d.adapter, tags: [...new Set([...d.tags, ...c.tags])].slice(0, 8), why: c.why, origin });
    }
    return out;
  }

  private async readText(uri: vscode.Uri, max = 60_000): Promise<string | undefined> {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (bytes.byteLength > max || bytes.includes(0)) return undefined;
      return new TextDecoder().decode(bytes);
    } catch {
      return undefined;
    }
  }

  private async readProject(folder: vscode.WorkspaceFolder): Promise<{ files: ProjectFile[]; stack: Stack; manifests: Record<string, string> }> {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, "**/*"), EXCLUDE, 800);
    const files: ProjectFile[] = [];
    for (const u of uris) {
      const path = vscode.workspace.asRelativePath(u, false).replace(/\\/g, "/");
      if (isSensitivePath(path)) continue;
      let size = 0;
      if (/\.(php|js|jsx|mjs|ts|tsx|py|java|go|rs|rb|css|scss|html|vue|svelte|kt|cs|swift)$/i.test(path) && files.length < 400) size = await vscode.workspace.fs.stat(u).then((s) => s.size, () => 0);
      files.push({ path, size });
    }
    const manifests: Record<string, string> = {};
    const present: Record<string, string> = {};
    for (const name of STACK_FILES) {
      const t = await this.readText(vscode.Uri.joinPath(folder.uri, name), 300_000);
      if (t !== undefined) {
        present[name] = t;
        if (/\.(json|toml|txt)$|^Pipfile$|^Gemfile$/.test(name)) manifests[name] = t;
      }
    }
    return { files, stack: withLanguagesFromFiles(detectStack(present), files), manifests };
  }

  private async review(ai: NonNullable<Awaited<ReturnType<Kraken["backend"]>>>, folder: vscode.WorkspaceFolder, samples: ProjectFile[], stack: Stack, lang: string): Promise<void> {
    const signal = this.abort!.signal;
    const all = await this.host.lib.activeChunks();
    if (!all.length) return void this.step("review", "skipped", "Aún no hay documentación guardada para comparar");
    this.step("review", "doing", "Preparando…");
    const owners = new Map(all.map((a) => [a.chunk.id, a.source]));
    const tags = stackTags(stack, vscode.window.activeTextEditor?.document.languageId);
    const index = new SearchIndex(all.map((a) => a.chunk), (c) => tagBoost(owners.get(c.id)?.tags ?? [], tags));
    const paths: string[] = [];
    const active = this.host.targetEditor();
    if (active && vscode.workspace.getWorkspaceFolder(active.document.uri)?.uri.toString() === folder.uri.toString()) paths.push(vscode.workspace.asRelativePath(active.document.uri, false).replace(/\\/g, "/"));
    for (const f of samples) if (!paths.includes(f.path)) paths.push(f.path);
    let done = 0;
    for (const rel of paths.slice(0, 5)) {
      if (signal.aborted || this.proposals.length >= MAX_PROPOSALS) break;
      done++;
      this.step("review", "doing", `${done}/${Math.min(paths.length, 5)} · ${rel}`);
      const uri = vscode.Uri.joinPath(folder.uri, ...rel.split("/"));
      const text = await this.readText(uri, 40_000);
      if (!text || isSensitivePath(rel)) continue;
      const terms = [...extractTerms(text), ...tags];
      const hits = index.search(terms.join(" "), 5).map((h) => h.chunk).filter((c) => !c.flagged?.length);
      if (!hits.length) continue;
      const urls: string[] = [];
      const sources = hits.map((c) => {
        let i = urls.indexOf(c.url);
        if (i < 0) i = urls.push(c.url) - 1;
        return { n: i + 1, title: c.title, url: c.url, text: c.text.slice(0, 900) };
      });
      const raw = await this.chat(ai.backend, refactorRequest(rel, redactSecrets(text), sources, describeStack(stack), lang, Math.floor(ai.budget * 0.5)), 240_000);
      if (!raw) continue;
      for (const p of parseProposals(raw, text, urls.length)) {
        if (this.proposals.length >= MAX_PROPOSALS) break;
        const src = p.source ? sources.find((s) => s.n === p.source) : undefined;
        this.proposals.push({ id: `p${++this.seq}`, file: rel, uri: uri.toString(), title: p.title, reason: p.reason, source: src && { title: src.title, url: src.url }, original: p.original, replacement: p.replacement, status: "pending" });
        this.host.changed();
      }
    }
    this.step("review", "done", this.proposals.length ? `${this.proposals.length} propuesta(s) esperan tu aprobación` : "No encontré nada claramente mejor");
  }

  // --- Aprobar, rechazar y comparar ----------------------------------------------------------------------------------

  private async locate(p: KrakenProposal): Promise<{ doc: vscode.TextDocument; start: number; orig: string } | undefined> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(p.uri));
    const orig = p.original.replace(/\n/g, doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n");
    const text = doc.getText();
    const start = text.indexOf(orig);
    if (start < 0 || text.indexOf(orig, start + 1) >= 0) {
      p.status = "stale";
      this.host.changed();
      void vscode.window.showInformationMessage("Conexiones: ese fragmento ya cambió en el archivo, así que no se aplicó. Pide una nueva revisión al Kraken.");
      return undefined;
    }
    return { doc, start, orig };
  }

  async approve(id: string): Promise<void> {
    const p = this.proposals.find((x) => x.id === id && x.status === "pending");
    if (!p) return;
    const found = await this.locate(p);
    if (!found) return;
    const risks = riskyCode(p.replacement);
    if (risks.length) {
      const ok = await vscode.window.showWarningMessage(`Este código puede ser peligroso:\n\n${risks.map((r) => `• ${r.message}`).join("\n")}`, { modal: true }, "Aplicar de todos modos");
      if (ok !== "Aplicar de todos modos") return;
    }
    const { doc, start, orig } = found;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(start + orig.length)), p.replacement.replace(/\n/g, eol));
    if (!(await vscode.workspace.applyEdit(edit))) return void vscode.window.showWarningMessage("Conexiones: no se pudo aplicar el cambio.");
    p.status = "applied";
    this.host.changed();
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(doc.positionAt(start), doc.positionAt(start + p.replacement.length)), preserveFocus: false });
    vscode.window.setStatusBarMessage(`$(check) Refactorización aplicada en ${p.file}`, 4000);
  }

  reject(id: string): void {
    this.proposals = this.proposals.filter((x) => x.id !== id);
    this.host.changed();
  }

  async diff(id: string): Promise<void> {
    const p = this.proposals.find((x) => x.id === id && x.status === "pending");
    if (!p) return;
    const found = await this.locate(p);
    if (!found) return;
    const eol = found.doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    const text = found.doc.getText();
    await showDiff(found.doc, text.slice(0, found.start) + p.replacement.replace(/\n/g, eol) + text.slice(found.start + found.orig.length), `Kraken: ${p.title} — ${p.file}`);
  }

  // --- Para la vista --------------------------------------------------------------------------------------------------------

  view() {
    return {
      on: this.on,
      running: this.running,
      steps: this.steps,
      resources: this.resources,
      connections: this.connections.filter((c) => !c.sourceId || this.host.lib.get(c.sourceId)),
      proposals: this.proposals,
      notes: this.notes.slice(-8),
      error: this.error,
      lastRun: this.lastRun,
    };
  }
}

/** Proyectos sin manifiesto (un curso de C, scripts sueltos…): el lenguaje se deduce de las extensiones de los archivos. */
const EXT_LANG: Record<string, string> = { c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", py: "python", java: "java", go: "go", rs: "rust", rb: "ruby", php: "php", js: "javascript", mjs: "javascript", ts: "typescript", tsx: "typescript", cs: "csharp", kt: "kotlin", swift: "swift", html: "html", css: "css", scss: "css" };
export function withLanguagesFromFiles(stack: Stack, files: readonly ProjectFile[]): Stack {
  const count = new Map<string, number>();
  for (const f of files) {
    const lang = EXT_LANG[/\.([A-Za-z0-9]+)$/.exec(f.path)?.[1]?.toLowerCase() ?? ""];
    if (lang) count.set(lang, (count.get(lang) ?? 0) + 1);
  }
  const found = [...count].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1]).map(([l]) => l);
  return { ...stack, languages: [...new Set([...stack.languages, ...found])] };
}

function describeOk(url: string) {
  const d = describeUrl(url, urlPolicy());
  return d.ok ? d : undefined;
}
