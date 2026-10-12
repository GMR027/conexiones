// vscode simulado SOLO para las pruebas (test/smoke.test.ts). Lo que no se define a mano es un Proxy que acepta cualquier uso.
// vscode simulado: lo que no se define a mano es un Proxy que acepta cualquier uso.
const log = { info: [], warn: [], error: [], calls: [] };
const mk = (name) => {
  const f = function () {};
  return new Proxy(f, {
    get: (_t, p) => (p === "then" ? undefined : p === Symbol.toPrimitive ? () => name : p === "dispose" ? () => {} : mk(`${name}.${String(p)}`)),
    apply: () => mk(`${name}()`),
    construct: () => mk(`new ${name}`),
  });
};
class EventEmitter { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} }
class Position { constructor(l, c) { this.line = l; this.character = c; } }
class Range { constructor(a, b, c, d) { if (typeof a === "number") { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } } get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; } }
class Selection extends Range {}
class Diagnostic { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } }
class DocumentLink { constructor(range, target) { Object.assign(this, { range, target }); } }
class TreeItem { constructor(label, state) { Object.assign(this, { label, collapsibleState: state }); } }
class ThemeIcon { constructor(id) { this.id = id; } }
class ThemeColor { constructor(id) { this.id = id; } }
class CodeAction { constructor(title, kind) { Object.assign(this, { title, kind }); } }
class RelativePattern { constructor(b, p) { this.base = b; this.pattern = p; } }
class WorkspaceEdit { replace() {} }
class Disposable { static from() { return { dispose() {} }; } }
class Uri {
  constructor(o) { Object.assign(this, o); }
  static file(p) { return new Uri({ scheme: "file", path: p, fsPath: p }); }
  static parse(s) { return new Uri({ scheme: "https", path: s }); }
  static from(o) { return new Uri({ fsPath: o.path, ...o }); }
  static joinPath(u, ...parts) { const p = [u.path, ...parts].join("/").replace(/\/+/g, "/"); return new Uri({ ...u, path: p, fsPath: p }); }
  with(o) { return new Uri({ ...this, ...o }); }
  toString() { return `${this.scheme}:${this.path}`; }
}
const commands = new Map();
const messages = [];
const msg = (kind) => (m, ...rest) => { messages.push([kind, m]); return Promise.resolve(undefined); };
const settings = {};
const config = { get: (k, d) => (k in settings ? settings[k] : d), update: async (k, v) => { settings[k] = v; }, has: () => false, inspect: () => undefined };
const vscode = new Proxy({
  EventEmitter, Position, Range, Selection, Diagnostic, DocumentLink, TreeItem, ThemeIcon, ThemeColor, RelativePattern, CodeAction, WorkspaceEdit, Disposable, Uri,
  EndOfLine: { LF: 1, CRLF: 2 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
  TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
  SymbolKind: new Proxy({}, { get: (_t, p) => (typeof p === "string" ? p.length : 0) }),
  ProgressLocation: { Notification: 15, Window: 10 },
  ViewColumn: { Beside: -2, One: 1 },
  CodeActionKind: { QuickFix: "quickfix" },
  StatusBarAlignment: { Left: 1, Right: 2 },
  commands: { registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; }, executeCommand: async () => undefined },
  env: { language: "es", clipboard: { readText: async () => "", writeText: async () => {} }, openExternal: async () => true },
  window: {
    createOutputChannel: () => ({ info: (m) => log.info.push(m), warn: (m) => log.warn.push(m), error: (m) => log.error.push(m), dispose() {} }),
    registerTreeDataProvider: () => ({ dispose() {} }), registerWebviewViewProvider: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }), onDidChangeTextEditorSelection: () => ({ dispose() {} }), onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    activeTextEditor: undefined, visibleTextEditors: [], showInformationMessage: msg("info"), showWarningMessage: msg("warn"), showErrorMessage: msg("error"),
    showQuickPick: async () => undefined, showInputBox: async () => undefined, showOpenDialog: async () => undefined, setStatusBarMessage: () => ({ dispose() {} }),
    withProgress: async (_o, task) => task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
    showTextDocument: async () => undefined, createStatusBarItem: () => mk("statusbar"),
  },
  workspace: {
    workspaceFolders: undefined, textDocuments: [], isTrusted: true, getConfiguration: () => config, getWorkspaceFolder: () => undefined,
    onDidOpenTextDocument: () => ({ dispose() {} }), onDidSaveTextDocument: () => ({ dispose() {} }), onDidCloseTextDocument: () => ({ dispose() {} }),
    onDidChangeTextDocument: () => ({ dispose() {} }), onDidChangeConfiguration: () => ({ dispose() {} }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }), registerTextDocumentContentProvider: () => ({ dispose() {} }),
    asRelativePath: (u) => String(u?.path ?? u), findFiles: async () => [], openTextDocument: async () => { throw new Error("no doc"); }, fs: { readFile: async () => { throw new Error("ENOENT"); }, stat: async () => { throw new Error("ENOENT"); }, readDirectory: async () => [], writeFile: async () => {}, createDirectory: async () => {}, delete: async () => {} },
    createFileSystemWatcher: () => mk("watcher"), applyEdit: async () => true,
  },
  languages: { createDiagnosticCollection: () => ({ set() {}, delete() {}, clear() {}, dispose() {} }), registerCodeActionsProvider: () => ({ dispose() {} }), registerDocumentLinkProvider: () => ({ dispose() {} }) },
  extensions: { getExtension: () => undefined, onDidChange: () => ({ dispose() {} }), all: [] },
}, { get: (t, p) => (p in t ? t[p] : mk(`vscode.${String(p)}`)) });
module.exports = Object.assign(vscode, { __commands: commands, __messages: messages, __log: log, __settings: settings });
