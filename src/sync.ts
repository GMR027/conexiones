import * as vscode from "vscode";
import { syncDocs, type SyncCtx } from "./connectors/docs";
import { syncFontAwesome } from "./connectors/icons";
import { syncFonts } from "./connectors/fonts";
import { searchImages, type ImageProvider } from "./connectors/images";
import { mcpPolicy, probeHttp } from "./connectors/mcp";
import { REGISTRIES, searchRegistry } from "./connectors/registry";
import { settings, urlPolicy } from "./config";
import { safeFetch, type FetchFn } from "./net/safeFetch";
import type { Library, Source } from "./store/library";

export interface SyncProgress {
  id: string;
  done: number;
  total: number;
  message: string;
}

export const secretKey = (id: string) => `conexiones.source.${id}`;

/** Descarga con la política de seguridad vigente (se lee en cada llamada, para que un cambio de ajustes cuente enseguida). */
export const boundFetch = (signal?: AbortSignal): FetchFn => (url, extra) => safeFetch(url, { policy: urlPolicy(), signal, ...extra });

/** Sincroniza de una en una (para no saturar la red) y permite cancelar. */
export class SyncManager {
  private current?: { id: string; abort: AbortController };
  private queue: Promise<unknown> = Promise.resolve();
  progress?: SyncProgress;

  constructor(
    private readonly lib: Library,
    private readonly secrets: vscode.SecretStorage,
    private readonly log: vscode.LogOutputChannel,
    private readonly changed: () => void,
  ) {}

  get busy(): string | undefined {
    return this.current?.id;
  }

  cancel(): void {
    this.current?.abort.abort();
  }

  /** Pone la conexión en la cola y la sincroniza cuando le toque. */
  run(id: string): Promise<void> {
    const job = this.queue.then(() => this.runNow(id));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async runNow(id: string): Promise<void> {
    const source = this.lib.get(id);
    if (!source || !source.enabled) return;
    const abort = new AbortController();
    this.current = { id, abort };
    this.progress = { id, done: 0, total: 0, message: "Empezando…" };
    await this.lib.update(id, { status: "syncing", error: undefined });
    this.changed();
    try {
      await this.dispatch(source, abort.signal);
    } catch (e) {
      const message = abort.signal.aborted ? "Sincronización cancelada." : (e as Error).message;
      this.log.warn(`${source.name}: ${message}`);
      await this.lib.update(id, { status: "error", error: message.slice(0, 300) });
    } finally {
      this.current = undefined;
      this.progress = undefined;
      this.changed();
    }
  }

  private async dispatch(source: Source, signal: AbortSignal): Promise<void> {
    const fetch = boundFetch(signal);
    const set = settings();
    switch (source.adapter) {
      case "docs":
      case "github":
      case "docs-file": {
        const ctx: SyncCtx = {
          lib: this.lib,
          fetch,
          signal,
          delayMs: set.delayMs,
          progress: (done, total, message) => {
            this.progress = { id: source.id, done, total, message };
            this.changed();
          },
        };
        const r = await syncDocs(source, ctx);
        if (r.cancelled) await this.lib.update(source.id, { status: "error", error: "Cancelada: se guardó lo descargado hasta ese momento." });
        else if (r.notes.length) this.log.info(`${source.name}: ${r.notes.join(" · ")}`);
        return;
      }
      case "fontawesome": {
        this.progress = { id: source.id, done: 0, total: 1, message: "Descargando la lista de iconos…" };
        this.changed();
        await syncFontAwesome(this.lib, source, fetch);
        return;
      }
      case "packagist":
      case "npm": {
        // No hay nada que descargar de antemano: se comprueba que el registro responde.
        await searchRegistry(REGISTRIES[source.adapter], "test", fetch, Date.now() + 1);
        await this.lib.update(source.id, { status: "ok", lastSync: Date.now(), error: undefined });
        return;
      }
      case "googlefonts": {
        this.progress = { id: source.id, done: 0, total: 1, message: "Descargando la lista de fuentes…" };
        this.changed();
        await syncFonts(this.lib, source, fetch);
        return;
      }
      case "unsplash":
      case "pexels":
      case "openverse": {
        const key = await this.secrets.get(secretKey(source.id));
        if (source.adapter !== "openverse" && !key) throw new Error("Falta la clave de acceso de esta conexión.");
        await searchImages(source.adapter as ImageProvider, key, "nature", fetch);
        await this.lib.update(source.id, { status: "ok", lastSync: Date.now(), error: undefined });
        return;
      }
      case "mcp-http": {
        const key = await this.secrets.get(secretKey(source.id));
        const header = String(source.meta?.header ?? "Authorization");
        const headers = key ? { [header]: header.toLowerCase() === "authorization" && !/^(bearer|basic) /i.test(key) ? `Bearer ${key}` : key } : {};
        const st = await probeHttp(source.url, headers, fetch, mcpPolicy(urlPolicy(), source.url));
        await this.lib.update(source.id, { status: st.state === "active" ? "ok" : "error", error: st.state === "active" ? undefined : st.detail, lastSync: Date.now(), meta: { ...source.meta, state: st.state, detail: st.detail, ms: st.ms ?? 0 } });
        return;
      }
      default:
        throw new Error(`Tipo de conexión desconocido (${source.adapter}).`);
    }
  }
}
