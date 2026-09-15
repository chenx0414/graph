import { createApp } from './app.ts';
import { openTaskRuntime } from '../core/task-runtime.ts';
import { RuntimeError } from '../core/types.ts';
import type { ConfigStore } from './config-service.ts';

export interface StartupInfo {
  mode: 'view' | 'execute';
  configured: boolean;
  modelCount: number;
  enabledModelCount: number;
  /** Revision the running daemon actually uses; differs from the saved one until restart. */
  effectiveRevision?: number;
  /** Credential alias to canonical scheduling identity, for limit displays. */
  limitAliases?: Record<string, string>;
}

export interface AppServices {
  applyConfig(document: unknown, expectedRevision: number): Promise<{ revision: number; effectiveRevision: number; applied: boolean; reason?: string | undefined; configured: boolean; modelCount: number; enabledModelCount: number }>;
  pushSecret(ref: string, value: string | null): Promise<{ revision: number; effectiveRevision: number; applied: boolean; reason?: string | undefined; configured: boolean; modelCount: number; enabledModelCount: number }>;
  appToken: string;
  snapshot(): { revision: number; effectiveRevision: number; applied: boolean; configured: boolean; modelCount: number; enabledModelCount: number };
  /** Explicit price snapshot refresh (C01): re-verify archived entries against
   * their official pages and persist/activate through the same live path. */
  refreshPrices?(expectedRevision: number): Promise<{ revision: number; effectiveRevision: number; applied: boolean; reason?: string | undefined; configured: boolean; modelCount: number; enabledModelCount: number; results: { modelId: string; provider: string; status: string; sourceUrl?: string; reason?: string }[] }>;
}

export async function openGraphServer(options: Parameters<typeof openTaskRuntime>[0] & { origin?: string; port?: number; autoDrive?: boolean; webDir?: string; startup?: StartupInfo; startupInfo?: () => StartupInfo; configStore?: ConfigStore; configEnv?: Record<string, string | undefined>; configTest?: (modelId: string) => Promise<unknown>; appServices?: AppServices }) {
  const runtime = await openTaskRuntime(options);
  const app = await createApp(runtime, { origin: options.origin ?? 'http://127.0.0.1', ...(options.webDir ? { webDir: options.webDir } : {}), ...(options.startup ? { startup: options.startup } : {}), ...(options.startupInfo ? { startupInfo: options.startupInfo } : {}), ...(options.configStore ? { config: { store: options.configStore, env: options.configEnv ?? {} } } : {}), ...(options.configTest ? { configTest: options.configTest } : {}), ...(options.appServices ? { appServices: options.appServices } : {}) });
  let address: string;
  try {
    address = await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  } catch (error) {
    await app.close().catch(() => undefined);
    await runtime.close().catch(() => undefined);
    const port = options.port ?? 0;
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new RuntimeError('port_in_use', `Port ${port} is already in use on 127.0.0.1; choose another port with --port`);
    throw error;
  }
  const url = typeof address === 'string' ? address : `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;
  let stopped = false;
  let driving = Boolean(options.autoDrive);
  let loop: Promise<void> | undefined;
  const ensureLoop = () => {
    if (loop || stopped) return;
    loop = (async () => {
      while (!stopped) {
        if (driving) await runtime.host.drive();
        await new Promise(resolve => setTimeout(resolve, driving ? 40 : 200));
      }
    })();
  };
  ensureLoop();
  let closed = false;
  return {
    runtime, app, url,
    /** Hot configuration apply activates the drive loop on the same process. */
    startDrive() { driving = true; ensureLoop(); },
    stopDrive() { driving = false; },
    driving: () => driving,
    async close() {
      if (closed) return;
      closed = true;
      stopped = true;
      if (loop) await loop;
      // Long-lived SSE connections must not keep the daemon from stopping.
      app.server.closeAllConnections();
      await app.close();
      await runtime.close();
    },
  };
}
