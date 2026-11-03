import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect } from 'vitest';
import { _electron } from 'playwright';
import { build } from 'vite';
import { vendorProxy } from './vendor-proxy.ts';
import { ensureBackendBinary } from './backend-binary.ts';

const electronExecutable: string = createRequire(import.meta.url)('electron');

/** Launch the packaged desktop shell against this checkout. `vendorOrigin`
 * routes the named vendor hosts through a controlled TLS stand-in so a test can
 * exercise a real authorization flow without borrowing an account. The caller
 * owns `cleanup`, so each test file tears down only what it started. */
export async function launchShell(cleanup: (() => Promise<void>)[], vendorOrigin?: string, hosts: string[] = ['openrouter.ai']) {
  const tooling = join(process.cwd(), '.tooling');
  await mkdir(tooling, { recursive: true });
  const root = await mkdtemp(join(tooling, 'desktop-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source');
  const userData = join(root, 'user-data');
  await mkdir(source);
  await mkdir(join(root, '.graph'));
  for (const directory of ['src', 'presets', 'docs']) await cp(join(process.cwd(), directory), join(source, directory), { recursive: true });
  await cp(join(process.cwd(), 'package.json'), join(source, 'package.json'));
  await mkdir(join(source, 'dist'));
  await cp(ensureBackendBinary(), join(source, 'dist/graphd'));
  const proxy = vendorOrigin ? await vendorProxy(root, hosts, vendorOrigin) : undefined;
  if (proxy) cleanup.push(() => proxy.close());

  await writeFile(join(root, '.graph/app-root'), `${source}\n`);
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: join(source, 'dist/web'), emptyOutDir: true } });
  const app = await _electron.launch({
    executablePath: electronExecutable,
    timeout: 15000,
    // Chromium's test keychain prevents an OS password dialog in an isolated
    // HOME. These cases cover windows/processes, not keychain encryption.
    args: ['--use-mock-keychain', join(process.cwd(), 'desktop/main.mjs')],
    env: { ...process.env, ...proxy?.env, HOME: root, GRAPH_APP_USER_DATA: userData, GRAPH_RSI_ROOT: join(root, 'stale'), GRAPH_APP_DEBUG: '1', GRAPH_APP_SMOKE: '', GRAPH_APP_BACKGROUND: process.env.GRAPH_E2E_VISIBLE_WINDOWS === '1' ? '' : '1', ELECTRON_RUN_AS_NODE: '' },
  });
  cleanup.push(() => app.close());
  let daemonLog = '';
  app.process().stdout?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString(); });
  app.process().stderr?.on('data', (chunk: Buffer) => { daemonLog += chunk.toString(); });
  let page;
  try { page = await app.firstWindow({ timeout: 60000 }); }
  catch (error) {
    await writeFile('/tmp/graph-desktop-e2e-startup.log', `No window after launch\n${daemonLog}`);
    throw error;
  }
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => window.graph?.isDesktop === true);
  try {
    await expect.poll(() => readFile(join(userData, 'state/console.json'), 'utf8').then(() => true, () => false), { timeout: 10000 }).toBe(true);
  } catch (error) {
    await writeFile('/tmp/graph-desktop-e2e-startup.log', daemonLog);
    throw error;
  }
  const address = async () => JSON.parse(await readFile(join(userData, 'state/console.json'), 'utf8')) as { url: string; pid: number };
  return { root, source, userData, app, page, address };
}
