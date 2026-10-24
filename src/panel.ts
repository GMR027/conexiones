import { accessSync, constants } from "node:fs";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ask as askAssistant, resetAssistantCache, type Answer } from "./assistant";
import { describeUrl, type Description } from "./connectors/detect";
import { parseHtml } from "./core/html";
import { FONT_CATEGORIES, FONT_PAGE, fontSnippet, pickWeights, searchFonts, type FontRec, type FontWhat } from "./connectors/fonts";
import { FA_STYLES, faHtml, faSvg, searchIcons, type FaStyle, type IconRec } from "./connectors/icons";
import { attributionHtml, cssBackground, cleanFilters, IMAGE_PROVIDERS, imageFileName, imgTag, safeFolder, searchImages, sniffImage, trackDownload, type ImageFilters, type ImageProvider, type Photo } from "./connectors/images";
import { findCommand, mcpPolicy, parseMcpConfig, probeHttp, statusStdio, type McpServer, type McpStatus } from "./connectors/mcp";
import { clearSearchCache, REGISTRIES, savePackage, searchRegistry, type Pkg } from "./connectors/registry";
import { enableApiMode } from "./commands";
import { cfg, defaultApiModel, getApiKey, PROVIDER_LABELS, settings, update, urlPolicy, usesOwnCredentials } from "./config";
import { SearchIndex } from "./core/search";
import { riskyCode } from "./core/safety";
import { detectStack, describeStack, EMPTY_STACK, STACK_FILES, stackTags, tagBoost, type Stack } from "./core/project";
import { cleanReply, resolveLanguage, TABS } from "./core/registry";
import { parseHostList } from "./core/urlPolicy";
import { buildVectors, findEmbedModel, semanticSearch } from "./embeddings";
import { Kraken } from "./kraken";
import { linkPeers, peerContext, peerStatus } from "./triconnect";
import { inspectLocal, type LocalStatus } from "./localGuard";
import { FetchError, safeFetch } from "./net/safeFetch";
import { explainRequest } from "./core/assistantPrompts";
import { previewContext } from "./propose";
import { chatBackend, quickChat, runChat } from "./runChat";
import { isSourceId, Library, type Source } from "./store/library";
import { boundFetch, secretKey, SyncManager } from "./sync";

type Msg = { type: string; [k: string]: unknown };

const str = (v: unknown, max = 500): string => (typeof v === "string" ? v.slice(0, max) : "");
const NAME = /^[a-z0-9][a-z0-9._/@-]{0,200}$/i;
const SETTINGS: Record<string, { kind: "boolean" | "number" | "hosts" | "language" | "folder"; min?: number; max?: number }> = {
  "security.allowHttp": { kind: "boolean" },
  "security.allowPrivateNetwork": { kind: "boolean" },
  "security.blockedDomains": { kind: "hosts" },
  "sync.ttlHours": { kind: "number", min: 1, max: 720 },
  "sync.maxPages": { kind: "number", min: 5, max: 1000 },
  "sync.delayMs": { kind: "number", min: 200, max: 10_000 },
  "storage.maxMb": { kind: "number", min: 20, max: 5000 },
  "search.embeddings": { kind: "boolean" },
  "images.folder": { kind: "folder" },
  "share.enabled": { kind: "boolean" },
  "triconnect.enabled": { kind: "boolean" },
  language: { kind: "language" },
};

/** Conexiones que se pueden crear con un clic (no piden clave). */
const QUICK_CONNECT: Record<string, string> = { openverse: "https://openverse.org/", googlefonts: "https://fonts.google.com/", fontawesome: "https://fontawesome.com/" };

/** Vista lateral de Conexiones. */
export class ConexionesPanel implements vscode.WebviewViewProvider {
  static readonly viewId = "conexiones.panel";

  private view?: vscode.WebviewView;
  private local?: LocalStatus;
  private readonly sync: SyncManager;
  private readonly kraken: Kraken;

  private answer?: Answer;
  private asking = false;
  private analysis?: { description: Extract<Description, { ok: true }>; probe?: { title: string; note: string }; problem?: string };
  private analysisError?: string;
  private libSearch?: { query: string; fragments: { title: string; url: string; heading: string; text: string; source: string }[] };
  private pkgSearch?: { query: string; items: { sourceId: string; pkg: Pkg }[]; error?: string };
  private icons?: { query: string; style: string; hits: { name: string; label: string; styles: FaStyle[]; paths: Record<string, { v: number[]; d: string }> }[]; total: number };
  private iconCache = new Map<string, { at: number; icons: IconRec[] }>();
  private photos?: { query: string; provider: string; items: Photo[]; remaining?: number; total: number; page: number; pages: number; filters: ImageFilters; error?: string };
  private fontCache = new Map<string, { at: number; fonts: FontRec[] }>();
  private fonts?: { query: string; category: string; hits: FontRec[]; total: number; page: number; pages: number };
  private askPhase = "";
  private shared = new Map<string, { calls: number; found: number }>();
  private explainCache = new Map<string, string>();
  private preview?: { code: string; explain: { state: "loading" | "ready" | "none"; text?: string }; canInsert: boolean; file: string; line: number; col: number; replaceLines: number; before: string; after: string; risks: string[]; stale?: boolean; uri: string; version: number; start: number; end: number };
  private lastEditor?: vscode.TextEditor;
  private readonly tracked = new Set<string>();
  private readonly mcp = new Map<string, McpStatus>();
  private mcpServers: McpServer[] = [];
  private stack: Stack = EMPTY_STACK;
  private embedModel?: string;
  private vectorProgress?: { done: number; total: number };
  private working = new Set<string>();
  private tab = "assistant";

  constructor(
    private readonly context: vscode.ExtensionContext,
    readonly lib: Library,
    private readonly log: vscode.LogOutputChannel,
  ) {
    this.sync = new SyncManager(lib, context.secrets, log, () => void this.post());
    this.kraken = new Kraken({
      lib,
      secrets: context.secrets,
      state: context.globalState,
      log,
      changed: () => void this.post(),
      syncRun: (id) => this.sync.run(id),
      syncCancel: (id) => this.sync.busy === id && this.sync.cancel(),
      discard: (id) => this.discardSource(id),
      aiReady: () => this.aiReady(),
      targetEditor: () => this.targetEditor(),
    });
    void this.kraken.recover().then((n) => void (n && this.post()));
    this.lastEditor = vscode.window.activeTextEditor;
    // Al hacer clic en el panel el editor deja de estar «activo»: se recuerda el último archivo que se miraba.
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((e) => e && e.document.uri.scheme === "file" && (this.lastEditor = e)));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    const media = vscode.Uri.joinPath(this.context.extensionUri, "media");
    view.webview.options = { enableScripts: true, localResourceRoots: [media] };
    view.webview.html = this.html(view.webview, media);
    view.webview.onDidReceiveMessage((m: Msg) => void this.handle(m).catch((e) => this.fail(e)));
    view.onDidChangeVisibility(() => view.visible && void this.refresh());
    view.onDidDispose(() => (this.view = undefined));
  }

  private fail(e: unknown): void {
    const message = (e as Error).message ?? String(e);
    this.log.error(message);
    void vscode.window.showErrorMessage(`Conexiones: ${message}`);
    void this.post();
  }

  async refresh(): Promise<void> {
    this.local = await inspectLocal();
    this.stack = await this.readStack();
    this.mcpServers = await this.readMcpConfigs();
    this.embedModel = settings().embeddings && cfg().mode === "local" && this.local.reachable ? await findEmbedModel(this.local.url, settings().embeddingModel).catch(() => undefined) : undefined;
    await this.kraken.refreshResources();
    await this.post();
  }

  /** Cuenta las consultas que hacen otras extensiones a la biblioteca (para mostrarlo en Ajustes). */
  noteShared(from: string, found: number): void {
    const s = this.shared.get(from) ?? { calls: 0, found: 0 };
    this.shared.set(from, { calls: s.calls + 1, found: s.found + found });
    void this.post();
  }

  /** Muestra el panel en una pestaña (lo usan los comandos). */
  async show(tab: string): Promise<void> {
    this.tab = tab;
    await vscode.commands.executeCommand("workbench.view.extension.conexiones");
    await this.view?.webview.postMessage({ type: "tab", tab });
  }

  /** Pregunta desde el comando de la paleta. */
  async askFrom(question: string): Promise<void> {
    await this.show("assistant");
    await this.ask(question);
  }

  async addFrom(url: string): Promise<void> {
    await this.show("connections");
    await this.analyze(url);
  }

  async syncStale(all = false): Promise<number> {
    let n = 0;
    for (const s of this.lib.list()) {
      if (!s.enabled || !["docs", "icons", "fonts"].includes(s.kind)) continue;
      if (all || this.stale(s)) (void this.sync.run(s.id), n++);
    }
    return n;
  }

  // --- Mensajes de la vista ------------------------------------------------------------------

  private async handle(m: Msg): Promise<void> {
    switch (m.type) {
      case "ready":
      case "refresh":
        return this.refresh();
      case "tab":
        this.tab = str(m.tab, 20);
        return;
      case "mode":
        if (m.mode === "api") await enableApiMode(this.context.secrets);
        else await update("mode", "local");
        return this.refresh();
      case "configureApi":
        await vscode.commands.executeCommand("conexiones.configureApi");
        return this.refresh();
      case "ask":
        return this.ask(str(m.question, 600));
      case "analyze":
        return this.analyze(str(m.url, 2100));
      case "cancelAnalysis":
        this.analysis = undefined;
        this.analysisError = undefined;
        return this.post();
      case "connect":
        return this.connect(m);
      case "sync":
        return void (isSourceId(m.id) && this.sync.run(m.id));
      case "syncAll":
        await this.syncStale(true);
        return;
      case "cancelSync":
        return this.sync.cancel();
      case "toggle":
        return this.toggle(str(m.id, 20));
      case "remove":
        return this.remove(str(m.id, 20));
      case "clearData":
        return this.clearData(str(m.id, 20));
      case "clearAll":
        return this.clearAll();
      case "copy":
        return this.copy(str(m.text, 20_000));
      case "krakenToggle":
        return this.kraken.setOn(m.on === true);
      case "krakenScan":
        return void (await this.kraken.scan());
      case "krakenStop":
        return this.kraken.stop();
      case "krakenApprove":
        return this.kraken.approve(str(m.id, 12));
      case "krakenReject":
        return this.kraken.reject(str(m.id, 12));
      case "krakenDiff":
        return this.kraken.diff(str(m.id, 12));
      case "previewCode":
        return this.previewInsert(str(m.code, 20_000));
      case "confirmInsert":
        return this.confirmInsert();
      case "cancelPreview":
        this.preview = undefined;
        return this.post();
      case "quickConnect":
        return this.quickConnect(str(m.what, 20));
      case "fontSearch":
        return this.searchFontsCmd(str(m.query, 60), str(m.category, 20), Number(m.page) || 1);
      case "fontInsert":
        return this.insertFont(str(m.id, 90), str(m.what, 10), Array.isArray(m.weights) ? m.weights.slice(0, 9) : [], m.italic === true);
      case "fontCopy":
        return this.copyFont(str(m.id, 90), str(m.what, 10), Array.isArray(m.weights) ? m.weights.slice(0, 9) : [], m.italic === true);
      case "openUrl":
        return this.openUrl(str(m.url, 2100));
      case "libSearch":
        return this.searchLibrary(str(m.query, 200));
      case "pkgSearch":
        return this.searchPackages(str(m.query, 100));
      case "pkgSave":
        return this.savePkg(str(m.sourceId, 20), str(m.name, 214));
      case "iconSearch":
        return this.searchIconsCmd(str(m.query, 60), str(m.style, 10));
      case "iconCopy":
        return this.copyIcon(str(m.name, 80), str(m.style, 10), str(m.what, 10));
      case "photoSearch":
        return this.searchPhotosCmd(str(m.query, 100), str(m.provider, 20), Number(m.page) || 1, cleanFilters(m.filters));
      case "photoCopy":
        return this.copyPhoto(str(m.id, 80), str(m.what, 12));
      case "photoSave":
        return this.savePhoto(str(m.id, 80), str(m.size, 10));
      case "mcpCheck":
        return this.checkMcp(str(m.key, 200));
      case "mcpCheckAll":
        return this.checkAllMcp();
      case "setSetting":
        return this.setSetting(str(m.key, 60), m.value);
      case "openStorage":
        return void (await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(this.lib.root)));
      case "prepareVectors":
        return this.prepareVectors();
    }
  }

  // --- Asistente ------------------------------------------------------------------------------

  private async ask(question: string): Promise<void> {
    if (!question.trim() || this.asking) return;
    this.asking = true;
    this.answer = undefined;
    this.askPhase = "Empezando…";
    await this.post();
    try {
      const local = (this.local ??= await inspectLocal());
      const ai = await this.aiReady();
      const backend = ai ? await this.aiBackend() : undefined;
      const lang = resolveLanguage(cfg().language, vscode.env.language, process.env);
      const editorLang = vscode.window.activeTextEditor?.document.languageId;
      const answer = await askAssistant(question, {
        lib: this.lib,
        fetch: boundFetch(),
        projectTags: stackTags(this.stack, editorLang),
        stackText: describeStack(this.stack) + (settings().triconnectEnabled && settings().shareEnabled ? await peerContext(question) : ""),
        lang,
        onPhase: (t) => {
          this.askPhase = t;
          void this.post();
        },
        ask: backend
          ? async (req, what, opts) => (opts?.quiet ? quickChat(backend, req) : ((await runChat(backend, req, what, this.log)) ?? undefined))
          : undefined,
        semantic: this.embedModel ? (q) => semanticSearch(this.lib, q, local.url, this.embedModel!) : undefined,
      });
      if (answer.answer) answer.answer = cleanReply(answer.answer);
      if (!backend && !ai) answer.notes.unshift("La IA no está lista (mira el estado arriba), así que no puedo redactar una respuesta.");
      this.answer = answer;
    } finally {
      this.asking = false;
      this.askPhase = "";
      await this.post();
    }
  }

  /** La IA para responder: con el Kraken encendido, lo mejor que haya (modelo más grande y todo el hardware, o el mejor modelo de la API). */
  private async aiBackend() {
    if (this.kraken.on) {
      const k = await this.kraken.backend().catch(() => undefined);
      if (k) return k.backend;
    }
    return chatBackend(this.context.secrets);
  }

  private async aiReady(): Promise<boolean> {
    const c = cfg();
    if (c.mode === "api") return !!(await getApiKey(this.context.secrets, c.apiProvider)) || c.apiProvider === "openai-compatible" || usesOwnCredentials(c.apiProvider);
    const local = (this.local ??= await inspectLocal());
    return local.reachable && !!local.model;
  }

  // --- Conexiones -----------------------------------------------------------------------------

  private async analyze(url: string): Promise<void> {
    this.analysis = undefined;
    this.analysisError = undefined;
    const d = describeUrl(url, urlPolicy());
    if (!d.ok) {
      this.analysisError = d.reason;
      return this.post();
    }
    if (this.lib.list().some((s) => s.url === d.url)) {
      this.analysisError = "Esa dirección ya está conectada.";
      return this.post();
    }
    const entry: NonNullable<ConexionesPanel["analysis"]> = { description: d };
    this.analysis = entry;
    await this.post();
    if (d.kind === "docs") {
      try {
        const target = d.adapter === "github" ? undefined : d.url;
        if (target) {
          const r = await safeFetch(target, { policy: urlPolicy(), accept: ["text/html", "text/plain", "text/markdown"], maxBytes: 1.5 * 1024 * 1024, timeoutMs: 15_000 });
          const page = r.headers["content-type"]?.includes("html") ? parseHtml(r.text, r.url) : undefined;
          entry.probe = { title: page?.title || d.name, note: page ? `La página responde (${page.blocks.length} bloques de texto, ${page.links.length} enlaces).` : "El documento responde." };
        }
      } catch (e) {
        entry.problem = `No pude abrir esa dirección: ${(e as Error).message}`;
      }
    }
    await this.post();
  }

  private async connect(m: Msg): Promise<void> {
    const d = describeUrl(str(m.url, 2100), urlPolicy());
    if (!d.ok) return void vscode.window.showWarningMessage(`Conexiones: ${d.reason}`);
    if (this.lib.list().some((s) => s.url === d.url)) return void vscode.window.showInformationMessage("Conexiones: esa dirección ya está conectada.");
    const key = str(m.key, 300).trim();
    if (d.key && !d.key.optional && !key) return void vscode.window.showInformationMessage(`Conexiones: falta ${d.key.label}.`);
    if (d.warnings.length) {
      const ok = await vscode.window.showWarningMessage(`Antes de conectar ${d.name}:\n\n${d.warnings.join("\n")}`, { modal: true }, "Conectar de todos modos");
      if (ok !== "Conectar de todos modos") return;
    }
    const tags = str(m.tags, 200).toLowerCase().split(/[\s,;]+/).map((t) => t.replace(/[^a-z0-9+#.-]/g, "").slice(0, 24)).filter(Boolean);
    const header = str(m.header, 60).trim();
    const set = settings();
    const source = await this.lib.add({
      kind: d.kind,
      adapter: d.adapter,
      name: (str(m.name, 60).trim() || d.name).replace(/[\u0000-\u001f]/g, ""),
      url: d.url,
      tags: [...new Set([...d.tags, ...tags])].slice(0, 10),
      ttlHours: set.ttlHours,
      maxPages: set.maxPages,
      meta: d.kind === "mcp" ? { header: /^[A-Za-z0-9-]{1,60}$/.test(header) ? header : (d.key?.header ?? "Authorization") } : undefined,
    });
    if (key) await this.context.secrets.store(secretKey(source.id), key);
    this.analysis = undefined;
    this.analysisError = undefined;
    resetAssistantCache();
    await this.post();
    void this.sync.run(source.id).then(() => this.afterSync(source.id));
  }

  private async afterSync(id: string): Promise<void> {
    const s = this.lib.get(id);
    if (s?.kind === "docs" && s.status === "ok" && this.embedModel) await this.prepareVectors(id).catch(() => undefined);
    await this.post();
  }

  private async toggle(id: string): Promise<void> {
    const s = isSourceId(id) ? this.lib.get(id) : undefined;
    if (!s) return;
    await this.lib.update(id, { enabled: !s.enabled });
    resetAssistantCache();
    await this.post();
  }

  /** Borra una conexión y todo lo guardado de ella: datos, clave y cachés (sin preguntar; lo usa el Kraken para limpiar lo incompleto). */
  private async discardSource(id: string): Promise<void> {
    if (!isSourceId(id) || !this.lib.get(id)) return;
    if (this.sync.busy === id) this.sync.cancel();
    await this.lib.remove(id);
    await this.context.secrets.delete(secretKey(id));
    this.iconCache.delete(id);
    this.fontCache.delete(id);
    this.mcp.delete(id);
    resetAssistantCache();
    clearSearchCache();
    await this.post();
  }

  /** Quitar una conexión borra también todo lo que se guardó de ella (y su clave). */
  private async remove(id: string): Promise<void> {
    const s = isSourceId(id) ? this.lib.get(id) : undefined;
    if (!s) return;
    const mb = (s.bytes / 1048576).toFixed(1);
    const detail = s.kind === "docs" || s.kind === "registry" || s.kind === "icons" || s.kind === "fonts" ? `Se borrarán de tu equipo ${s.pages} página(s) / ${s.chunks} fragmento(s) guardados (${mb} MB).` : "Se borrará lo guardado de esta conexión.";
    const ok = await vscode.window.showWarningMessage(`¿Quitar «${s.name}»?`, { modal: true, detail: `${detail}\nTambién se borra su clave, si la tenías guardada.` }, "Quitar y borrar datos");
    if (ok !== "Quitar y borrar datos") return;
    if (this.sync.busy === id) this.sync.cancel();
    await this.lib.remove(id);
    await this.context.secrets.delete(secretKey(id));
    this.iconCache.delete(id);
    this.mcp.delete(id);
    resetAssistantCache();
    clearSearchCache();
    if (this.answer) this.answer = undefined;
    this.libSearch = undefined;
    this.icons = undefined;
    this.fonts = undefined;
    this.fontCache.delete(id);
    this.photos = undefined;
    await this.post();
    vscode.window.setStatusBarMessage(`$(trash) «${s.name}» quitada y sus datos borrados`, 5000);
  }

  private async clearData(id: string): Promise<void> {
    const s = isSourceId(id) ? this.lib.get(id) : undefined;
    if (!s) return;
    const ok = await vscode.window.showWarningMessage(`¿Vaciar los datos guardados de «${s.name}»?`, { modal: true, detail: "La conexión se mantiene; para volver a tener los datos hay que sincronizarla." }, "Vaciar datos");
    if (ok !== "Vaciar datos") return;
    if (this.sync.busy === id) this.sync.cancel();
    await this.lib.clearData(id);
    this.iconCache.delete(id);
    this.fontCache.delete(id);
    resetAssistantCache();
    await this.post();
  }

  private async clearAll(): Promise<void> {
    const n = this.lib.list().length;
    const ok = await vscode.window.showWarningMessage("¿Borrar TODAS las conexiones y sus datos?", { modal: true, detail: `Se quitarán ${n} conexión(es) y todo lo guardado en tu equipo, incluidas las claves.` }, "Borrar todo");
    if (ok !== "Borrar todo") return;
    this.sync.cancel();
    for (const s of this.lib.list()) await this.context.secrets.delete(secretKey(s.id));
    await this.lib.clearAll();
    this.iconCache.clear();
    this.fontCache.clear();
    this.mcp.clear();
    this.answer = this.libSearch = this.pkgSearch = this.icons = this.fonts = this.photos = undefined;
    resetAssistantCache();
    clearSearchCache();
    await this.post();
  }

  // --- Copiar / insertar / abrir ---------------------------------------------------------------

  /** Si el texto contiene algo que puede dañar el equipo, se avisa y se pide confirmación. */
  private async confirmRisky(code: string, action: string): Promise<boolean> {
    const risks = riskyCode(code);
    if (!risks.length) return true;
    const ok = await vscode.window.showWarningMessage(`Este código puede ser peligroso:\n\n${risks.map((r) => `• ${r.message}`).join("\n")}`, { modal: true, detail: "Revísalo con calma antes de ejecutarlo. Conexiones nunca lo ejecuta por ti." }, action);
    return ok === action;
  }

  private async copy(text: string): Promise<void> {
    if (!text.trim() || !(await this.confirmRisky(text, "Copiar de todos modos"))) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage("$(check) Copiado", 2500);
  }

  /** Archivo donde se insertaría: el activo, o el último que se miraba (al hacer clic en el panel el editor deja de estar activo). */
  private targetEditor(): vscode.TextEditor | undefined {
    const file = (e?: vscode.TextEditor) => (e && e.document.uri.scheme === "file" && !e.document.isClosed ? e : undefined);
    return file(vscode.window.activeTextEditor) ?? file(this.lastEditor) ?? vscode.window.visibleTextEditors.find((e) => file(e));
  }

  /** Abre la ventana «Preview»: explica qué hace el código y muestra dónde y qué se insertará, sin tocar el archivo todavía. */
  private async previewInsert(code: string): Promise<void> {
    if (!code.trim()) return;
    const editor = this.targetEditor();
    const base = { code, risks: riskyCode(code).map((r) => r.message), explain: { state: "loading" as const }, canInsert: !!editor };
    if (editor) {
      const doc = editor.document;
      const sel = editor.selection;
      const start = doc.offsetAt(sel.start);
      const end = doc.offsetAt(sel.end);
      this.preview = { ...base, file: vscode.workspace.asRelativePath(doc.uri), line: sel.start.line + 1, col: sel.start.character + 1, replaceLines: start === end ? 0 : sel.end.line - sel.start.line + 1, ...previewContext(doc.getText(), start, end), uri: doc.uri.toString(), version: doc.version, start, end };
    } else {
      this.preview = { ...base, file: "", line: 0, col: 0, replaceLines: 0, before: "", after: "", uri: "", version: 0, start: 0, end: 0 };
    }
    const cached = this.explainCache.get(code);
    if (cached !== undefined) this.preview.explain = cached ? { state: "ready", text: cached } : { state: "none" };
    await this.post();
    if (cached === undefined) void this.explain(code, editor?.document.languageId);
  }

  /** Pide a la IA una explicación breve de lo que hace el código (sin ejecutarlo). */
  private async explain(code: string, languageId?: string): Promise<void> {
    let text = "";
    try {
      if (await this.aiReady()) {
        const backend = await this.aiBackend();
        if (backend) text = cleanReply((await quickChat(backend, explainRequest(code, describeStack(this.stack), languageId, resolveLanguage(cfg().language, vscode.env.language, process.env)), 60_000)) ?? "");
      }
    } catch {
      text = "";
    }
    if (text) this.explainCache.set(code, text);
    if (this.preview?.code !== code) return;
    this.preview.explain = text ? { state: "ready", text } : { state: "none" };
    await this.post();
  }

  /** Aplica exactamente lo que se vio en el Preview (si el archivo no cambió mientras tanto). */
  private async confirmInsert(): Promise<void> {
    const pv = this.preview;
    if (!pv?.canInsert) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === pv.uri);
    if (!doc || doc.version !== pv.version) {
      pv.stale = true;
      return this.post();
    }
    if (!(await this.confirmRisky(pv.code, "Insertar de todos modos"))) return;
    const range = new vscode.Range(doc.positionAt(pv.start), doc.positionAt(pv.end));
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, pv.code);
    const ok = await vscode.workspace.applyEdit(edit);
    this.preview = undefined;
    await this.post();
    if (!ok) return void vscode.window.showWarningMessage("Conexiones: no se pudo insertar el código.");
    const end = doc.positionAt(pv.start + pv.code.length);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(doc.positionAt(pv.start), end), preserveFocus: false });
    vscode.window.setStatusBarMessage(`$(check) Código insertado en ${pv.file}:${pv.line}`, 4000);
  }

  /** Solo se abren direcciones que Conexiones conoce (fuentes, páginas guardadas, paquetes y fotos mostradas). */
  private async openUrl(url: string): Promise<void> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") return;
    const known = new Set<string>();
    for (const s of this.lib.list()) known.add(s.url);
    for (const a of this.answer?.sources ?? []) known.add(a.url);
    for (const f of [...(this.answer?.fragments ?? []), ...(this.libSearch?.fragments ?? [])]) known.add(f.url);
    for (const p of [...(this.answer?.packages ?? []), ...(this.pkgSearch?.items.map((i) => i.pkg) ?? [])]) known.add(p.url);
    for (const p of this.photos?.items ?? []) (known.add(p.page), known.add(p.authorPage));
    if (!known.has(u.href)) {
      for (const s of this.lib.list()) for (const pg of (await this.lib.data(s.id)).pages) known.add(pg.url);
    }
    if (known.has(u.href)) await vscode.env.openExternal(vscode.Uri.parse(u.href));
  }

  // --- Biblioteca -------------------------------------------------------------------------------

  private async searchLibrary(query: string): Promise<void> {
    if (!query.trim()) {
      this.libSearch = undefined;
      return this.post();
    }
    const all = await this.lib.activeChunks();
    const owners = new Map(all.map((a) => [a.chunk.id, a.source]));
    const tags = stackTags(this.stack, vscode.window.activeTextEditor?.document.languageId);
    const index = new SearchIndex(all.map((a) => a.chunk), (c) => tagBoost(owners.get(c.id)?.tags ?? [], tags));
    this.libSearch = {
      query,
      fragments: index.search(query, 20).map(({ chunk: c }) => ({ title: c.title, url: c.url, heading: c.heading, text: c.text.length > 600 ? `${c.text.slice(0, 600)}…` : c.text, source: owners.get(c.id)?.name ?? "" })),
    };
    await this.post();
  }

  private registries(): Source[] {
    return this.lib.list().filter((s) => s.enabled && s.kind === "registry" && REGISTRIES[s.adapter]);
  }

  private async searchPackages(query: string): Promise<void> {
    if (!query.trim()) return;
    this.working.add("pkg");
    this.pkgSearch = { query, items: [] };
    await this.post();
    try {
      for (const s of this.registries()) {
        try {
          for (const pkg of await searchRegistry(REGISTRIES[s.adapter], query, boundFetch())) this.pkgSearch.items.push({ sourceId: s.id, pkg });
        } catch (e) {
          this.pkgSearch.error = `${REGISTRIES[s.adapter].label}: ${(e as Error).message}`;
        }
      }
    } finally {
      this.working.delete("pkg");
      await this.post();
    }
  }

  private async savePkg(sourceId: string, name: string): Promise<void> {
    const s = isSourceId(sourceId) ? this.lib.get(sourceId) : undefined;
    const adapter = s && REGISTRIES[s.adapter];
    if (!s || !adapter || !NAME.test(name) || !adapter.validName(name)) return;
    this.working.add(`save:${name}`);
    await this.post();
    try {
      await savePackage(this.lib, s, adapter, name, boundFetch());
      resetAssistantCache();
      vscode.window.setStatusBarMessage(`$(check) «${name}» guardado en tu biblioteca`, 4000);
    } finally {
      this.working.delete(`save:${name}`);
      await this.post();
    }
  }

  // --- Recursos: iconos -------------------------------------------------------------------------

  private async loadIcons(): Promise<IconRec[]> {
    const src = this.lib.list().find((s) => s.enabled && s.adapter === "fontawesome" && s.lastSync);
    if (!src) return [];
    const hit = this.iconCache.get(src.id);
    if (hit && hit.at === src.lastSync) return hit.icons;
    const file = await this.lib.readFile<{ icons?: IconRec[] }>(src.id, "icons.json", {});
    const icons = Array.isArray(file.icons) ? file.icons : [];
    this.iconCache.set(src.id, { at: src.lastSync!, icons });
    return icons;
  }

  private async searchIconsCmd(query: string, style: string): Promise<void> {
    const icons = await this.loadIcons();
    const st = (FA_STYLES as readonly string[]).includes(style) ? (style as FaStyle) : undefined;
    const hits = searchIcons(icons, query, st, 60);
    const byName = new Map(icons.map((i) => [i.n, i]));
    this.icons = {
      query,
      style: st ?? "",
      total: icons.length,
      hits: hits.map((h) => ({ ...h, paths: Object.fromEntries(Object.entries(byName.get(h.name)?.s ?? {}).map(([k, v]) => [k, { v: v!.v, d: v!.d }])) })),
    };
    await this.post();
  }

  private async copyIcon(name: string, style: string, what: string): Promise<void> {
    if (!/^[a-z0-9-]+$/.test(name) || !(FA_STYLES as readonly string[]).includes(style)) return;
    const icon = (await this.loadIcons()).find((i) => i.n === name);
    if (!icon) return;
    const st = style as FaStyle;
    const text = what === "svg" ? faSvg(icon, st) : what === "class" ? `fa-${st} fa-${name}` : what === "name" ? name : faHtml(name, st);
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`$(check) ${what === "svg" ? "SVG" : what === "class" ? "Clases" : what === "name" ? "Nombre" : "Etiqueta <i>"} de «${name}» copiado`, 3000);
  }

  // --- Recursos: fuentes -------------------------------------------------------------------------

  private fontSource(): Source | undefined {
    return this.lib.list().find((s) => s.enabled && s.adapter === "googlefonts");
  }

  private async loadFonts(): Promise<FontRec[]> {
    const src = this.fontSource();
    if (!src?.lastSync) return [];
    const hit = this.fontCache.get(src.id);
    if (hit && hit.at === src.lastSync) return hit.fonts;
    const file = await this.lib.readFile<{ fonts?: FontRec[] }>(src.id, "fonts.json", {});
    const fonts = Array.isArray(file.fonts) ? file.fonts : [];
    this.fontCache.set(src.id, { at: src.lastSync, fonts });
    return fonts;
  }

  private async searchFontsCmd(query: string, category: string, page: number): Promise<void> {
    const fonts = await this.loadFonts();
    const cat = (FONT_CATEGORIES as readonly string[]).includes(category) ? category : "";
    const all = searchFonts(fonts, query, cat || undefined, 5000);
    const pages = Math.max(1, Math.ceil(all.length / FONT_PAGE));
    const pg = Math.max(1, Math.min(pages, Math.floor(page) || 1));
    this.fonts = { query, category: cat, hits: all.slice((pg - 1) * FONT_PAGE, pg * FONT_PAGE), total: all.length, page: pg, pages };
    await this.post();
  }

  private async fontText(id: string, what: string, weights: unknown[], italic: boolean): Promise<{ font: FontRec; text: string } | undefined> {
    if (!/^[a-z0-9-]+$/.test(id) || !["link", "import", "css", "npm"].includes(what)) return undefined;
    const font = (await this.loadFonts()).find((f) => f.id === id);
    return font && { font, text: fontSnippet(font, what as FontWhat, pickWeights(font, weights), italic) };
  }

  private async copyFont(id: string, what: string, weights: unknown[], italic: boolean): Promise<void> {
    const r = await this.fontText(id, what, weights, italic);
    if (!r) return;
    await vscode.env.clipboard.writeText(r.text);
    const label = { link: "Etiquetas <link>", import: "@import", css: "font-family", npm: "Comandos npm" }[what];
    vscode.window.setStatusBarMessage(`$(check) ${label} de «${r.font.f}» copiado`, 3000);
  }

  /** Inserta el código de cabecera de la fuente en el cursor, pasando por la ventana Preview. */
  private async insertFont(id: string, what: string, weights: unknown[], italic: boolean): Promise<void> {
    const r = await this.fontText(id, what, weights, italic);
    if (r) await this.previewInsert(r.text);
  }

  // --- Conexión rápida ------------------------------------------------------------------------------

  /** Conecta con un clic los servicios que no piden clave (Openverse, Google Fonts, Font Awesome). */
  private async quickConnect(what: string): Promise<void> {
    const url = QUICK_CONNECT[what];
    if (!url) return;
    const d = describeUrl(url, urlPolicy());
    if (!d.ok || this.lib.list().some((s) => s.url === d.url)) return;
    this.tab = "resources";
    await this.connect({ type: "connect", url: d.url });
  }

  // --- Recursos: imágenes -----------------------------------------------------------------------

  private imageSources(): Source[] {
    return this.lib.list().filter((s) => s.enabled && s.kind === "images" && s.adapter in IMAGE_PROVIDERS);
  }

  private async searchPhotosCmd(query: string, provider: string, page: number, filters: ImageFilters): Promise<void> {
    if (!query.trim()) return;
    const sources = this.imageSources();
    const source = sources.find((s) => s.adapter === provider) ?? sources[0];
    if (!source) return;
    const id = source.adapter as ImageProvider;
    const label = IMAGE_PROVIDERS[id].label;
    this.working.add("photos");
    this.photos = { query, provider: id, items: [], total: 0, page, pages: 1, filters };
    await this.post();
    try {
      const key = await this.context.secrets.get(secretKey(source.id));
      const r = await searchImages(id, key, query, boundFetch(), page, filters);
      this.photos = { query, provider: id, items: r.photos, total: r.total, remaining: r.remaining, page: r.page, pages: r.pages, filters };
    } catch (e) {
      const status = e instanceof FetchError ? e.status : undefined;
      const message = status === 429 ? `${label} limitó las búsquedas por ahora: espera un rato o prueba con otro servicio.` : status === 401 || status === 403 ? `${label} no aceptó la clave. Revisa que sea correcta (puedes quitar la conexión y volver a añadirla).` : (e as Error).message;
      this.photos = { query, provider: id, items: [], total: 0, page, pages: 1, filters, error: message };
    } finally {
      this.working.delete("photos");
      await this.post();
    }
  }

  private async unsplashKey(): Promise<string | undefined> {
    for (const source of this.imageSources().filter((s) => s.adapter === "unsplash")) {
      const key = await this.context.secrets.get(secretKey(source.id));
      if (key) return key;
    }
    return undefined;
  }

  private async copyPhoto(id: string, what: string): Promise<void> {
    const p = this.photos?.items.find((x) => x.id === id);
    if (!p) return;
    if (what === "open") return void (await vscode.env.openExternal(vscode.Uri.parse(p.page)));
    const text = what === "img" ? imgTag(p) : what === "css" ? cssBackground(p) : what === "url" ? p.regular : what === "credit" ? attributionHtml(p) : undefined;
    if (!text) return;
    await vscode.env.clipboard.writeText(text);
    // Unsplash pide avisar cuando una foto se usa de verdad.
    const key = p.provider === "unsplash" || !p.provider ? await this.unsplashKey() : undefined;
    if (key && what !== "credit" && !this.tracked.has(p.id)) {
      this.tracked.add(p.id);
      void trackDownload(key, p, boundFetch()).catch(() => undefined);
    }
    vscode.window.setStatusBarMessage(`$(check) Copiado${what === "credit" || p.license === "CC0" ? "" : " (recuerda dar el crédito al autor)"}`, 4000);
  }

  /** Descarga la imagen (con el filtro de red) y la guarda en la carpeta de imágenes del proyecto. */
  private async savePhoto(id: string, size: string): Promise<void> {
    const p = this.photos?.items.find((x) => x.id === id);
    if (!p) return;
    const editor = this.targetEditor();
    const folder = (editor && vscode.workspace.getWorkspaceFolder(editor.document.uri)) ?? vscode.workspace.workspaceFolders?.[0];
    if (!folder || !vscode.workspace.isTrusted) return void vscode.window.showInformationMessage("Conexiones: abre una carpeta de proyecto (de confianza) para guardar la imagen en ella. Mientras tanto puedes copiar la URL.");
    const key = `save:${p.id}`;
    this.working.add(key);
    await this.post();
    try {
      const url = size === "original" && p.original ? p.original : p.regular;
      const r = await boundFetch()(url, { accept: ["image/jpeg", "image/png", "image/webp", "image/gif"], maxBytes: 30 * 1024 * 1024, timeoutMs: 90_000 });
      const ext = sniffImage(r.bytes);
      if (!ext) throw new Error("Lo descargado no parece una imagen (JPG, PNG, WebP o GIF).");
      const parts = safeFolder(settings().imagesFolder);
      const dir = vscode.Uri.joinPath(folder.uri, ...parts);
      await vscode.workspace.fs.createDirectory(dir);
      const base = imageFileName(p, ext).replace(/\.[a-z]+$/, "");
      let name = `${base}.${ext}`;
      for (let n = 2; n < 50; n++) {
        const exists = await vscode.workspace.fs.stat(vscode.Uri.joinPath(dir, name)).then(() => true, () => false);
        if (!exists) break;
        name = `${base}-${n}.${ext}`;
      }
      const file = vscode.Uri.joinPath(dir, name);
      await vscode.workspace.fs.writeFile(file, r.bytes);
      const rel = [...parts, name].join("/");
      if (p.provider === "unsplash" || !p.provider) {
        const k = await this.unsplashKey();
        if (k && !this.tracked.has(p.id)) (this.tracked.add(p.id), void trackDownload(k, p, boundFetch()).catch(() => undefined));
      }
      const pick = await vscode.window.showInformationMessage(`Imagen guardada en ${rel} (${(r.bytes.length / 1024).toFixed(0)} KB).`, "Copiar ruta", "Copiar crédito", "Abrir");
      if (pick === "Copiar ruta") await vscode.env.clipboard.writeText(rel);
      else if (pick === "Copiar crédito") await vscode.env.clipboard.writeText(attributionHtml(p));
      else if (pick === "Abrir") await vscode.commands.executeCommand("vscode.open", file);
    } catch (e) {
      void vscode.window.showErrorMessage(`Conexiones: no se pudo guardar la imagen: ${(e as Error).message}`);
    } finally {
      this.working.delete(key);
      await this.post();
    }
  }

  // --- MCP --------------------------------------------------------------------------------------

  private async readMcpConfigs(): Promise<McpServer[]> {
    const files: { path: string; label: string }[] = [];
    const userDir = path.dirname(path.dirname(this.context.globalStorageUri.fsPath));
    files.push({ path: path.join(userDir, "mcp.json"), label: "Configuración del usuario (mcp.json)" });
    if (vscode.workspace.isTrusted) {
      for (const f of vscode.workspace.workspaceFolders ?? []) {
        files.push({ path: path.join(f.uri.fsPath, ".vscode", "mcp.json"), label: `${f.name}/.vscode/mcp.json` }, { path: path.join(f.uri.fsPath, ".mcp.json"), label: `${f.name}/.mcp.json` });
      }
    }
    const out: McpServer[] = [];
    for (const f of files) {
      try {
        const text = await readFile(f.path, "utf8");
        if (text.length < 200_000) out.push(...parseMcpConfig(text, f.label, process.env));
      } catch {
        // no existe: normal
      }
    }
    return out;
  }

  private async checkMcp(key: string): Promise<void> {
    if (isSourceId(key)) return void this.sync.run(key);
    const server = this.mcpServers.find((s) => `${s.origin}::${s.name}` === key);
    if (!server) return;
    this.working.add(key);
    await this.post();
    try {
      this.mcp.set(key, await this.statusOf(server));
    } finally {
      this.working.delete(key);
      await this.post();
    }
  }

  private async statusOf(server: McpServer): Promise<McpStatus> {
    if (server.missing.length) return { state: "missing", detail: `Falta configurar: ${server.missing.join(", ")}.` };
    if (server.type === "stdio") {
      const dirs = (process.env.PATH ?? "").split(path.delimiter);
      const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
      const exists = (p: string) => {
        try {
          accessSync(p, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      };
      return statusStdio(server, server.command ? findCommand(server.command, dirs, exists, exts) : undefined);
    }
    if (!server.url) return { state: "not-mcp", detail: "No tiene dirección." };
    const sub = (v: string) => v.replace(/\$\{env:([^}]+)\}|\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, a, b) => process.env[a ?? b] ?? "");
    const headers = Object.fromEntries(Object.entries(server.headers ?? {}).map(([k, v]) => [k, sub(v)]));
    return probeHttp(sub(server.url), headers, boundFetch(), mcpPolicy(urlPolicy(), sub(server.url)));
  }

  private async checkAllMcp(): Promise<void> {
    for (const s of this.lib.list().filter((x) => x.kind === "mcp" && x.enabled)) void this.sync.run(s.id);
    for (const s of this.mcpServers) await this.checkMcp(`${s.origin}::${s.name}`);
  }

  // --- Ajustes ----------------------------------------------------------------------------------

  private async setSetting(key: string, value: unknown): Promise<void> {
    const spec = SETTINGS[key];
    if (!spec) return;
    let v: unknown;
    if (spec.kind === "boolean") v = value === true;
    else if (spec.kind === "number") v = Math.min(spec.max!, Math.max(spec.min!, Math.round(Number(value)) || spec.min!));
    else if (spec.kind === "hosts") v = parseHostList(str(value, 4000));
    else if (spec.kind === "folder") v = safeFolder(str(value, 100)).join("/");
    else v = ["auto", "es", "en", "pt", "fr", "de", "it"].includes(str(value, 4)) ? str(value, 4) : "auto";
    if (key === "security.allowPrivateNetwork" && v === true) {
      const ok = await vscode.window.showWarningMessage("¿Permitir conexiones a tu red local y a tu propio equipo?", { modal: true, detail: "Esto desactiva la protección que impide que una página o un enlace malicioso use Conexiones para llegar a servicios internos (routers, bases de datos, metadatos de la nube). Actívalo solo si necesitas conectar un servidor tuyo." }, "Permitir");
      if (ok !== "Permitir") return this.post();
    }
    const conf = vscode.workspace.getConfiguration("conexiones");
    await conf.update(key, v, vscode.ConfigurationTarget.Global);
    // Triconnect necesita compartir: al encenderlo se activa también, y al apagar el compartir se apaga el Triconnect.
    if (key === "triconnect.enabled" && v === true) {
      await conf.update("share.enabled", true, vscode.ConfigurationTarget.Global);
      await linkPeers();
    }
    if (key === "share.enabled" && v === false) await conf.update("triconnect.enabled", false, vscode.ConfigurationTarget.Global);
    if (key === "search.embeddings") await this.refresh();
    else await this.post();
  }

  /** Calcula los vectores de la búsqueda por significado (opcional, requiere un modelo de embeddings en Ollama). */
  private async prepareVectors(only?: string): Promise<void> {
    const local = (this.local ??= await inspectLocal());
    if (!this.embedModel) return void vscode.window.showInformationMessage("Conexiones: activa «búsqueda por significado» en Ajustes y descarga un modelo de embeddings (p. ej. ollama pull nomic-embed-text).");
    const targets = this.lib.list().filter((s) => s.enabled && (s.kind === "docs" || s.kind === "registry") && (!only || s.id === only));
    for (const s of targets) {
      this.vectorProgress = { done: 0, total: s.chunks };
      await this.post();
      await buildVectors(this.lib, s, local.url, this.embedModel, (done, total) => {
        this.vectorProgress = { done, total };
        void this.post();
      });
    }
    this.vectorProgress = undefined;
    await this.post();
  }

  // --- Proyecto ---------------------------------------------------------------------------------

  private async readStack(): Promise<Stack> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !vscode.workspace.isTrusted) return EMPTY_STACK;
    const files: Record<string, string> = {};
    for (const name of STACK_FILES) {
      try {
        const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(folder.uri, name));
        files[name] = bytes.byteLength < 300_000 ? new TextDecoder().decode(bytes) : "";
      } catch {
        // no existe
      }
    }
    return detectStack(files);
  }

  // --- Estado para la vista ---------------------------------------------------------------------

  private stale(s: Source): boolean {
    return !!s.lastSync && Date.now() - s.lastSync > s.ttlHours * 3600_000;
  }

  private async post(): Promise<void> {
    if (!this.view) return;
    await this.view.webview.postMessage({ type: "state", state: await this.state() });
  }

  async state() {
    const c = cfg();
    const set = settings();
    const local = (this.local ??= await inspectLocal());
    let ready: boolean;
    let label: string;
    let problem: string | undefined;
    if (c.mode === "api") {
      const model = c.apiModel || defaultApiModel(c.apiProvider);
      const key = await getApiKey(this.context.secrets, c.apiProvider);
      label = `${PROVIDER_LABELS[c.apiProvider]} · ${model || (usesOwnCredentials(c.apiProvider) ? "predeterminado" : "sin modelo")}`;
      ready = (!!key || c.apiProvider === "openai-compatible" || usesOwnCredentials(c.apiProvider)) && (!!model || usesOwnCredentials(c.apiProvider));
      if (!ready) problem = "Falta la API key o el modelo. Pulsa para configurarlos.";
    } else {
      ready = local.reachable && !!local.model;
      label = local.model ? `Local · ${local.model}` : "Local";
      if (!local.reachable) problem = `Ollama no responde en ${local.url}.`;
      else if (!local.model) problem = local.notice?.text ?? "No hay un modelo de chat disponible.";
    }
    const sources = this.lib.list();
    const totalBytes = await this.lib.totalBytes();
    const pages: { sourceId: string; source: string; title: string; url: string; fetchedAt: number }[] = [];
    for (const s of sources.filter((x) => x.kind === "docs" || x.kind === "registry")) {
      for (const p of (await this.lib.data(s.id)).pages.slice(0, 300)) pages.push({ sourceId: s.id, source: s.name, title: p.title, url: p.url, fetchedAt: p.fetchedAt });
    }
    const imageSources = this.imageSources();
    const fa = this.lib.list().find((s) => s.enabled && s.adapter === "fontawesome");
    const gf = this.fontSource();
    return {
      version: String(this.context.extension.packageJSON.version ?? ""),
      tabs: TABS,
      tab: this.tab,
      ai: { mode: c.mode, ready, label, problem, notice: c.mode === "local" && local.reachable ? local.notice : undefined },
      project: describeStack(this.stack),
      sources: sources.map((s) => ({ ...s, stale: this.stale(s), meta: s.kind === "mcp" ? s.meta : undefined })),
      syncing: this.sync.progress,
      analysis: this.analysis && { ...this.analysis.description, probe: this.analysis.probe, problem: this.analysis.problem },
      analysisError: this.analysisError,
      asking: this.asking,
      askPhase: this.askPhase,
      answer: this.answer,
      preview: this.preview,
      kraken: this.kraken.view(),
      share: { enabled: set.shareEnabled, peers: this.peers() },
      triconnect: { enabled: set.triconnectEnabled && set.shareEnabled },
      pages: pages.slice(0, 600),
      libSearch: this.libSearch,
      pkgSearch: this.pkgSearch,
      hasRegistries: this.registries().length > 0,
      working: [...this.working],
      icons: { available: !!fa?.lastSync, syncing: !!fa && this.sync.busy === fa.id, results: this.icons, count: fa?.chunks ?? 0 },
      fonts: { available: !!gf?.lastSync, syncing: !!gf && this.sync.busy === gf.id, count: gf?.chunks ?? 0, categories: FONT_CATEGORIES, results: this.fonts },
      photos: { available: imageSources.length > 0, providers: imageSources.map((s) => ({ id: s.adapter, label: IMAGE_PROVIDERS[s.adapter as ImageProvider].label })), folder: settings().imagesFolder, results: this.photos },
      mcp: {
        manual: sources.filter((s) => s.kind === "mcp").map((s) => ({ id: s.id, name: s.name, url: s.url, status: s.meta?.state ? { state: String(s.meta.state), detail: String(s.meta.detail ?? ""), ms: Number(s.meta.ms) || undefined } : undefined })),
        configured: this.mcpServers.map((s) => ({ key: `${s.origin}::${s.name}`, name: s.name, origin: s.origin, type: s.type, target: s.url ?? s.command ?? "", status: this.mcp.get(`${s.origin}::${s.name}`) })),
      },
      storage: { path: this.lib.root, total: totalBytes, maxMb: set.maxMb },
      settings: { ...set, blockedDomains: set.blockedDomains.join("\n"), language: cfg().language },
      embed: { enabled: set.embeddings, model: this.embedModel, progress: this.vectorProgress },
    };
  }

  /** Las extensiones hermanas: si están instaladas, si ya consultan Conexiones y cuántas consultas han hecho. */
  private peers() {
    return peerStatus().map((p) => {
      const u = this.shared.get(p.id);
      return { ...p, calls: u?.calls ?? 0, found: u?.found ?? 0 };
    });
  }

  private html(webview: vscode.Webview, media: vscode.Uri): string {
    const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const css = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
    const mediaBase = webview.asWebviewUri(media).toString();
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; img-src data: ${webview.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>Conexiones</title>
</head>
<body data-media="${mediaBase}">
<div id="app"><p class="muted">Cargando…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
  }
}
