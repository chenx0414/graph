import { createApp } from './app.ts';
import { openTaskRuntime } from '../core/task-runtime.ts';
import { RuntimeError } from '../core/types.ts';
import type { ConfigStore } from './config-service.ts';

export interface StartupInfo {
  mode: 'view' | 'execute';
  configured: boolean;
  modelCount: number;
  enabledModelCount: number;
}

export async function openGraphServer(options: Parameters<typeof openTaskRuntime>[0] & { origin?: string; port?: number; autoDrive?: boolean; webDir?: string; startup?: StartupInfo; configStore?: ConfigStore; configEnv?: Record<string, string | undefined>; configTest?: (modelId: string) => Promise<unknown> }) {
  const runtime = await openTaskRuntime(options);
  const app = await createApp(runtime, { origin: options.origin ?? 'http://127.0.0.1', ...(options.webDir ? { webDir: options.webDir } : {}), ...(options.startup ? { startup: options.startup } : {}), ...(options.configStore ? { config: { store: options.configStore, env: options.configEnv ?? {} } } : {}), ...(options.configTest ? { configTest: options.configTest } : {}) });
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
  const loop = options.autoDrive ? (async () => {
    while (!stopped) {
      await runtime.host.drive();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  })() : Promise.resolve();
  let closed = false;
  return {
    runtime, app, url,
    async close() {
      if (closed) return;
      closed = true;
      stopped = true;
      await loop;
      await app.close();
      await runtime.close();
    },
  };
}
