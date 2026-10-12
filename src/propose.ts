import * as vscode from "vscode";

/** Documentos virtuales con el código propuesto, para compararlo con el diff nativo antes de aplicarlo. */
export const PROPOSED_SCHEME = "conexiones-proposed";
const proposed = new Map<string, string>();
export const proposedProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent: (uri) => proposed.get(uri.path) ?? "",
};

/** Texto resultante de reemplazar [start, end) por `code` (si start == end, se inserta en esa posición). */
export function applyCode(text: string, start: number, end: number, code: string): string {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return text.slice(0, a) + code + text.slice(b);
}

/** Muestra el diff nativo entre el documento y el resultado de insertar `code` en la selección o el cursor, y pregunta si aplicarlo. */
export async function proposeInsert(editor: vscode.TextEditor, code: string): Promise<boolean> {
  const doc = editor.document;
  const range = new vscode.Range(editor.selection.start, editor.selection.end);
  const newText = applyCode(doc.getText(), doc.offsetAt(range.start), doc.offsetAt(range.end), code);
  const key = `/${Date.now()}/${doc.uri.path.split("/").pop()}`;
  proposed.set(key, newText);
  const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: key });
  try {
    await vscode.commands.executeCommand("vscode.diff", doc.uri, right, `Conexiones: cambios propuestos en ${vscode.workspace.asRelativePath(doc.uri)}`, { preview: true });
    const pick = await vscode.window.showInformationMessage(range.isEmpty ? "¿Insertar el código en la posición del cursor?" : "¿Reemplazar la selección con el código propuesto?", "Aplicar", "Descartar");
    if (pick !== "Aplicar") return false;
    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, range, code);
    return await vscode.workspace.applyEdit(edit);
  } finally {
    proposed.delete(key);
  }
}

/** Una línea muy larga se recorta para la vista previa. */
const clip = (l: string) => (l.length > 160 ? `${l.slice(0, 160)}…` : l);

/** Lo que rodea al punto donde se insertará el código (hasta 3 líneas antes y 3 después), para la vista previa. */
export function previewContext(text: string, start: number, end: number): { before: string; after: string } {
  const a = Math.max(0, Math.min(start, text.length));
  const b = Math.max(a, Math.min(end, text.length));
  return {
    before: text.slice(Math.max(0, a - 600), a).split("\n").slice(-3).map(clip).join("\n"),
    after: text.slice(b, b + 600).split("\n").slice(0, 3).map(clip).join("\n"),
  };
}

/** Abre el diff nativo entre el documento y una versión propuesta (sin aplicar nada). */
export async function showDiff(doc: vscode.TextDocument, newText: string, title: string): Promise<void> {
  const key = `/${Date.now()}/${doc.uri.path.split("/").pop()}`;
  proposed.set(key, newText);
  await vscode.commands.executeCommand("vscode.diff", doc.uri, vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: key }), title, { preview: true });
  // El documento virtual se queda disponible un rato para que el diff pueda releerlo.
  setTimeout(() => proposed.delete(key), 10 * 60_000).unref?.();
}
