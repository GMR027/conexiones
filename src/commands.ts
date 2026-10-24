import * as vscode from "vscode";
import { ANTHROPIC_MODELS } from "./backends/anthropic";
import { CODESTRAL_DEFAULT_URL } from "./backends/codestral";
import { OPENAI_DEFAULT_URL } from "./backends/openaiCompat";
import { listOpencodeModels } from "./backends/opencode";
import { modelKind, type ModelKind } from "./core/opencode";
import { cfg, defaultApiModel, deleteApiKey, getApiKey, PROVIDER_LABELS, setApiKey, update, usesOwnCredentials, type ApiProvider } from "./config";

type Pick<T> = vscode.QuickPickItem & { value: T };

/** Activa el modo API, lanzando el asistente si el proveedor aún no está configurado. */
export async function enableApiMode(secrets: vscode.SecretStorage): Promise<void> {
  const c = cfg();
  const hasKey = await getApiKey(secrets, c.apiProvider);
  const needsModel = c.apiProvider === "openai-compatible" && !c.apiModel;
  const needsKey = c.apiProvider !== "openai-compatible" && !usesOwnCredentials(c.apiProvider);
  if ((!hasKey && needsKey) || needsModel) {
    if (!(await configureApi(secrets))) return;
  }
  await update("mode", "api");
}

/** Asistente de 3 pasos: proveedor, URL/modelo y API key. */
export async function configureApi(secrets: vscode.SecretStorage): Promise<boolean> {
  const c = cfg();
  const providers: Pick<ApiProvider>[] = [
    { label: "Anthropic Claude", detail: "Claude Opus / Sonnet / Haiku", value: "anthropic" },
    { label: "Mistral Codestral", detail: "Especializado en código", value: "codestral" },
    { label: "Compatible con OpenAI", detail: "OpenAI, DeepSeek, OpenRouter, Groq, LM Studio, vLLM…", value: "openai-compatible" },
    { label: "OpenCode", detail: "Modelos gratis o de tu suscripción (OpenCode Go), con tu sesión de «opencode auth login»", value: "opencode" },
  ];
  for (const p of providers) if (p.value === c.apiProvider) p.description = "● actual";
  const prov = await vscode.window.showQuickPick(providers, { title: "Conexiones — proveedor API (1/3)" });
  if (!prov) return false;
  const provider = prov.value;

  let baseUrl = provider === c.apiProvider ? c.apiBaseUrl : "";
  if (provider === "openai-compatible") {
    const url = await vscode.window.showInputBox({
      title: "Conexiones — URL base (2/3)",
      value: baseUrl || OPENAI_DEFAULT_URL,
      prompt: "Ej.: https://api.deepseek.com/v1 · https://openrouter.ai/api/v1 · http://localhost:1234/v1",
      ignoreFocusOut: true,
    });
    if (url === undefined) return false;
    baseUrl = url.trim();
  } else if (provider === "codestral") {
    const pick = await vscode.window.showQuickPick(
      [
        { label: CODESTRAL_DEFAULT_URL, detail: "Clave específica de Codestral", value: "" },
        { label: "https://api.mistral.ai/v1", detail: "Clave general de la API de Mistral", value: "https://api.mistral.ai/v1" },
      ],
      { title: "Conexiones — endpoint de Codestral (2/3)" },
    );
    if (!pick) return false;
    baseUrl = pick.value;
  }

  let model: string | undefined;
  const current = provider === c.apiProvider ? c.apiModel : "";
  if (provider === "anthropic") {
    const items: Pick<string>[] = ANTHROPIC_MODELS.map((m) => ({ label: m.id, detail: m.detail, value: m.id }));
    items.push({ label: "$(edit) Otro modelo…", value: "__other__" });
    const pick = await vscode.window.showQuickPick(items, { title: "Conexiones — modelo de Claude (3/3)" });
    if (!pick) return false;
    model = pick.value === "__other__" ? await vscode.window.showInputBox({ title: "ID del modelo", value: current }) : pick.value;
  } else if (provider === "opencode") {
    model = await pickOpencodeModel(current);
  } else {
    model = await vscode.window.showInputBox({
      title: "Conexiones — modelo (3/3)",
      value: current || defaultApiModel(provider),
      prompt: provider === "codestral" ? "Normalmente codestral-latest" : "Ej.: deepseek-chat, gpt-4.1-mini…",
      ignoreFocusOut: true,
    });
  }
  if (model === undefined || (!model && provider !== "opencode")) return false;

  await update("api.provider", provider);
  await update("api.baseUrl", baseUrl);
  await update("api.model", model);

  if (!usesOwnCredentials(provider) && !(await getApiKey(secrets, provider))) {
    const optional = provider === "openai-compatible";
    const key = await askApiKey(provider, optional);
    if (key === undefined && !optional) return false;
    if (key) await setApiKey(secrets, provider, key);
  }
  return true;
}

const OPENCODE_GROUPS: Record<ModelKind, string> = {
  free: "Gratis",
  subscription: "Suscripción OpenCode Go",
  other: "Otros modelos de tu cuenta",
};

/** Modelos de OpenCode agrupados por tipo de acceso. "" = el predeterminado de OpenCode. */
async function pickOpencodeModel(current: string): Promise<string | undefined> {
  const input = () =>
    vscode.window.showInputBox({
      title: "Conexiones — modelo de OpenCode (3/3)",
      value: current,
      prompt: "Formato proveedor/modelo, p. ej. opencode-go/claude-haiku-5-5. Vacío = el predeterminado de OpenCode.",
      ignoreFocusOut: true,
    });
  const models = await listOpencodeModels();
  if (models.length === 0) {
    void vscode.window.showWarningMessage("Conexiones: no encuentro OpenCode. Instálalo desde opencode.ai y ejecuta «opencode auth login».");
    return input();
  }
  const items: Pick<string>[] = [
    { label: "Predeterminado de OpenCode", detail: "El que tenga configurado OpenCode", value: "", description: current ? undefined : "● actual" },
  ];
  for (const kind of ["free", "subscription", "other"] as const) {
    const group = models.filter((m) => modelKind(m) === kind);
    if (group.length === 0) continue;
    items.push({ label: OPENCODE_GROUPS[kind], kind: vscode.QuickPickItemKind.Separator, value: "" });
    items.push(...group.map((m) => ({ label: m, value: m, description: m === current ? "● actual" : undefined })));
  }
  items.push({ label: "$(edit) Otro modelo…", value: "__other__" });
  const pick = await vscode.window.showQuickPick(items, { title: "Conexiones — modelo de OpenCode (3/3)", ignoreFocusOut: true });
  if (!pick) return undefined;
  return pick.value === "__other__" ? input() : pick.value;
}

async function askApiKey(provider: ApiProvider, optional: boolean): Promise<string | undefined> {
  const key = await vscode.window.showInputBox({
    title: `API key de ${PROVIDER_LABELS[provider]}`,
    prompt: `Se guarda cifrada en el llavero del sistema, nunca en settings.json.${optional ? " Déjala vacía si tu servidor local no la necesita." : ""}`,
    password: true,
    ignoreFocusOut: true,
  });
  return key?.trim() || undefined;
}

export async function setApiKeyCommand(secrets: vscode.SecretStorage): Promise<void> {
  if (usesOwnCredentials(cfg().apiProvider)) {
    void vscode.window.showInformationMessage("Conexiones: OpenCode usa su propia sesión. Ejecuta «opencode auth login» en una terminal.");
    return;
  }
  const key = await askApiKey(cfg().apiProvider, false);
  if (!key) return;
  await setApiKey(secrets, cfg().apiProvider, key);
  void vscode.window.showInformationMessage(`Conexiones: API key de ${PROVIDER_LABELS[cfg().apiProvider]} guardada.`);
}

export async function clearApiKeyCommand(secrets: vscode.SecretStorage): Promise<void> {
  await deleteApiKey(secrets, cfg().apiProvider);
  void vscode.window.showInformationMessage(`Conexiones: API key de ${PROVIDER_LABELS[cfg().apiProvider]} borrada.`);
}
