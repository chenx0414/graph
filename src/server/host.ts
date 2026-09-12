import { createApp } from './app.ts';
import { openTaskRuntime } from '../core/task-runtime.ts';

export async function openGraphServer(options: Parameters<typeof openTaskRuntime>[0] & { origin?: string; port?: number; autoDrive?: boolean; webDir?: string }) {
  const runtime = await openTaskRuntime(options);
  const app = await createApp(runtime, { origin: options.origin ?? 'http://127.0.0.1', ...(options.webDir ? { webDir: options.webDir } : {}) });
  const address = await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  const url = typeof address === 'string' ? address : `http://127.0.0.1:${(app.addresses()[0] as { port: number }).port}`;
  let stopped = false;
  const loop = options.autoDrive ? (async () => {
    while (!stopped) {
      await runtime.host.drive();
      await new Promise(resolve => setTimeout(resolve, 40));
    }
  })() : Promise.resolve();
  return {
    runtime, app, url,
    async close() {
      stopped = true;
      await loop;
      await app.close();
      await runtime.close();
    },
  };
}
