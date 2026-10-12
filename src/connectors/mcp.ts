import { isIP } from "node:net";
import { isPrivateAddress, type UrlPolicy } from "../core/urlPolicy";
import type { FetchFn } from "../net/safeFetch";

export interface McpServer {
  name: string;
  /** De qué archivo de configuración sale. */
  origin: string;
  type: "stdio" | "http" | "sse" | "unknown";
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  env?: Record<string, string>;
  /** Variables o entradas que la configuración usa y no se pueden resolver desde aquí. */
  missing: string[];
}

export type McpState = "active" | "ready" | "auth" | "missing" | "inactive" | "not-mcp" | "blocked";

export interface McpStatus {
  state: McpState;
  detail: string;
  ms?: number;
}

const PLACEHOLDER = /\$\{(input|env):([^}]+)\}|\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** Lo que falta para poder usar un valor de la configuración: `${input:x}` y variables de entorno sin definir. */
function unresolved(value: string, env: Record<string, string | undefined>): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(PLACEHOLDER)) {
    if (m[1] === "input") out.push(`entrada «${m[2]}»`);
    else {
      const name = m[2] ?? m[3];
      if (!env[name]) out.push(`variable ${name}`);
    }
  }
  return out;
}

const strMap = (v: unknown): Record<string, string> | undefined =>
  v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, x]) => typeof x === "string").map(([k, x]) => [k.slice(0, 80), String(x).slice(0, 2000)])) : undefined;

/** Servidores MCP de un archivo de configuración (formato de VS Code «servers» o de Claude/.mcp.json «mcpServers»). */
export function parseMcpConfig(text: string, origin: string, env: Record<string, string | undefined> = {}): McpServer[] {
  let json: any;
  try {
    json = JSON.parse(text.replace(/^﻿/, "").replace(/^\s*\/\/.*$/gm, ""));
  } catch {
    return [];
  }
  const table = json?.servers ?? json?.mcpServers ?? json?.mcp?.servers;
  if (!table || typeof table !== "object") return [];
  const out: McpServer[] = [];
  for (const [name, raw] of Object.entries(table as Record<string, any>).slice(0, 50)) {
    if (!raw || typeof raw !== "object") continue;
    const url = typeof raw.url === "string" ? raw.url.slice(0, 2048) : undefined;
    const command = typeof raw.command === "string" ? raw.command.slice(0, 500) : undefined;
    const type: McpServer["type"] = raw.type === "sse" ? "sse" : url ? "http" : command ? "stdio" : "unknown";
    const headers = strMap(raw.headers);
    const envVars = strMap(raw.env);
    const args = Array.isArray(raw.args) ? raw.args.filter((a: unknown) => typeof a === "string").slice(0, 30).map(String) : undefined;
    const missing = [...new Set([url ?? "", ...Object.values(headers ?? {}), ...Object.values(envVars ?? {}), ...(args ?? [])].flatMap((v) => unresolved(v, env)))];
    out.push({ name: name.slice(0, 80), origin, type, command, args, url, headers, env: envVars, missing });
  }
  return out;
}

const loopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";

/** Política para sondear un servidor MCP: solo se permite tu propio equipo (loopback) además de lo que permitan los ajustes. */
export function mcpPolicy(base: UrlPolicy, url: string): UrlPolicy {
  try {
    const u = new URL(url);
    if (loopback(u.hostname)) return { ...base, allowPrivate: true, allowHttp: true };
  } catch {
    // se rechaza más adelante
  }
  return base;
}

/** ¿Existe el ejecutable? Solo se mira el disco: NUNCA se ejecuta el comando de un servidor MCP. */
export function findCommand(command: string, pathDirs: string[], exists: (p: string) => boolean, exts: string[] = [""]): string | undefined {
  if (/[\\/]/.test(command)) return exists(command) ? command : undefined;
  for (const d of pathDirs) for (const e of exts) if (d && exists(`${d.replace(/[\\/]$/, "")}/${command}${e}`)) return `${d}/${command}${e}`;
  return undefined;
}

export function statusStdio(server: McpServer, found: string | undefined): McpStatus {
  if (server.missing.length) return { state: "missing", detail: `Falta configurar: ${server.missing.join(", ")}.` };
  if (!server.command) return { state: "not-mcp", detail: "La configuración no tiene comando." };
  if (!found) return { state: "inactive", detail: `No encuentro el programa «${server.command}» en tu equipo (¿está instalado?).` };
  return { state: "ready", detail: "Configurado y el programa existe. El editor lo inicia cuando lo necesita (no se ejecuta desde aquí)." };
}

export const INITIALIZE = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "conexiones", version: "0.2.0" } } });

/** Comprueba un servidor MCP por HTTP: un «initialize» de prueba, sin leer la respuesta y sin seguir redirecciones. */
export async function probeHttp(url: string, headers: Record<string, string>, fetch: FetchFn, policy: UrlPolicy): Promise<McpStatus> {
  const started = Date.now();
  try {
    const r = await fetch(url, {
      method: "POST",
      body: INITIALIZE,
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      sensitiveHeaders: Object.keys(headers),
      policy,
      probe: true,
      maxRedirects: 0,
      timeoutMs: 10_000,
    });
    const ms = Date.now() - started;
    const type = (r.headers["content-type"] ?? "").toLowerCase();
    if (r.status === 401 || r.status === 403) return { state: "auth", detail: Object.keys(headers).length ? "El servidor rechazó la clave (401/403): revísala." : "El servidor pide una clave (401/403) y no hay ninguna configurada.", ms };
    if (r.status >= 200 && r.status < 300) return /json|event-stream/.test(type) || r.status === 202 ? { state: "active", detail: "Responde correctamente.", ms } : { state: "not-mcp", detail: `Responde (${r.status}) pero no parece un servidor MCP (${type || "sin tipo"}).`, ms };
    if (r.status === 404 || r.status === 405) return { state: "not-mcp", detail: `La ruta responde ${r.status}: no parece la dirección de un servidor MCP.`, ms };
    if (r.status >= 300 && r.status < 400) return { state: "not-mcp", detail: "La dirección redirige a otra; usa la dirección final del servidor.", ms };
    return { state: "inactive", detail: `El servidor respondió ${r.status}.`, ms };
  } catch (e) {
    const err = e as { kind?: string; message: string };
    if (err.kind === "blocked") return { state: "blocked", detail: err.message };
    return { state: "inactive", detail: err.kind === "timeout" ? "No respondió a tiempo." : err.message };
  }
}

export const isLoopbackUrl = (url: string): boolean => {
  try {
    const h = new URL(url).hostname;
    return loopback(h) || (!!isIP(h) && isPrivateAddress(h));
  } catch {
    return false;
  }
};

/** Dónde buscar archivos de configuración de MCP (rutas relativas a la carpeta del proyecto y a la del usuario). */
export const MCP_WORKSPACE_FILES = [".vscode/mcp.json", ".mcp.json"];
