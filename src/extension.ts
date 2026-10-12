import * as path from "node:path";
import * as vscode from "vscode";
import { createApi, type ConexionesApi } from "./api";
import { clearApiKeyCommand, configureApi, setApiKeyCommand } from "./commands";
import { settings } from "./config";
import { ConexionesPanel } from "./panel";
import { PROPOSED_SCHEME, proposedProvider } from "./propose";
import { Library } from "./store/library";

let internals: { panel: ConexionesPanel; lib: Library } | undefined;
/** Solo para las pruebas: el panel y la biblioteca de la última activación. */
export const __internals = () => internals!;

export async function activate(context: vscode.ExtensionContext): Promise<ConexionesApi> {
  const log = vscode.window.createOutputChannel("Conexiones", { log: true });
  const lib = new Library(path.join(context.globalStorageUri.fsPath, "library"), settings().maxMb * 1024 * 1024);
  await lib.init();

  const secrets = context.secrets;
  const panel = new ConexionesPanel(context, lib, log);
  context.subscriptions.push(
    log,
    vscode.window.registerWebviewViewProvider(ConexionesPanel.viewId, panel),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, proposedProvider),
    vscode.commands.registerCommand("conexiones.openPanel", () => panel.show("assistant")),
    vscode.commands.registerCommand("conexiones.refreshPanel", () => panel.refresh()),
    vscode.commands.registerCommand("conexiones.ask", async (question?: string) => {
      const q = typeof question === "string" ? question : await vscode.window.showInputBox({ title: "Conexiones — pregunta", prompt: "Por ejemplo: ¿cómo envío correos desde PHP?", ignoreFocusOut: true });
      if (q?.trim()) await panel.askFrom(q.trim());
    }),
    vscode.commands.registerCommand("conexiones.addConnection", async (url?: string) => {
      const u = typeof url === "string" ? url : await vscode.window.showInputBox({ title: "Conexiones — nueva conexión", prompt: "Dirección de una web de ayuda, librería, paquetes, iconos, imágenes o servidor MCP", placeHolder: "https://packagist.org/", ignoreFocusOut: true });
      if (u?.trim()) await panel.addFrom(u.trim());
    }),
    vscode.commands.registerCommand("conexiones.syncAll", async () => {
      const n = await panel.syncStale(true);
      void vscode.window.showInformationMessage(n ? `Conexiones: sincronizando ${n} conexión(es).` : "Conexiones: no hay conexiones que sincronizar.");
    }),
    vscode.commands.registerCommand("conexiones.configureApi", () => configureApi(secrets)),
    vscode.commands.registerCommand("conexiones.setApiKey", () => setApiKeyCommand(secrets)),
    vscode.commands.registerCommand("conexiones.clearApiKey", () => clearApiKeyCommand(secrets)),
    // Cambió la configuración (modo, modelo, URL) o se instaló/desinstaló GhostCode.
    vscode.workspace.onDidChangeConfiguration((e) => (e.affectsConfiguration("conexiones") || e.affectsConfiguration("ghostcode")) && void panel.refresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void panel.refresh()),
    vscode.extensions.onDidChange(() => void panel.refresh()),
  );
  log.info(`Conexiones listo · ${lib.list().length} conexión(es)`);
  internals = { panel, lib };
  // API para GhostCode, MagicTools y otras extensiones: solo lee lo ya guardado, sin red ni IA.
  return createApi(lib, () => settings().shareEnabled, (from, found) => panel.noteShared(from, found), () => settings().triconnectEnabled);
}

export function deactivate() {}
