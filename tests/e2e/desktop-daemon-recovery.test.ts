import { execFileSync, spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';

// Every self-improvement restarts the daemon under a running window. The window
// used to treat that as a crash: a modal "Graph daemon stopped" and an app that
// quit, which the person met as "桌面有一个 Electron 崩溃退出的提示，遇到好多次".
// A restart is not a crash - the replacement daemon publishes its own
// console.json - so the runtime waits for it and keeps the window.
//
// The proof runs real graphd processes: one is killed mid-run (the restart) while
// a replacement appears, and the runtime has to report readiness again instead of
// reporting the daemon gone. A second case removes the replacement and requires
// the runtime to start one itself, still without alarming the reader.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

interface AppPaths {
  root: string; sourceRoot: string; stateDir: string; graphHome: string;
  configPath: string; secretsPath: string; serverEntry: string; webDir: string;
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-daemon-recovery-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  const graphHome = join(root, 'graph-home');
  const project = join(root, 'project');
  await mkdir(stateDir, { recursive: true });
  await mkdir(graphHome, { recursive: true });
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }] }));
  const paths: AppPaths = {
    root, sourceRoot: root, stateDir, graphHome, configPath,
    secretsPath: join(root, 'secrets.json'), serverEntry: ensureBackendBinary(), webDir: join(root, 'web'),
  };
  return { root, paths };
}

/** One daemon started outside the runtime, the way the host restarts it. */
function startDaemon(paths: AppPaths) {
  const child = spawn(paths.serverEntry, [
    '--state-dir', paths.stateDir, '--graph-home', paths.graphHome, '--web-dir', paths.webDir,
    '--port', '0', '--config', paths.configPath, '--execute', '--dynamic',
  ], { stdio: ['ignore', 'ignore', 'ignore'] });
  cleanup.push(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } });
  return child;
}

test('a restarted daemon is adopted again instead of alarming the window', async () => {
  const { paths } = await fixture();
  // The desktop runtime is plain JavaScript on purpose (no Electron import), so it
  // has no type declarations to import from a test.
  // @ts-expect-error plain-JS module
  const { createDaemonRuntime } = await import('../../desktop/daemon-runtime.mjs');
  const gone: string[] = [];
  const ready: string[] = [];
  const runtime = createDaemonRuntime({
    paths: () => paths,
    bin: () => paths.serverEntry,
    secrets: () => ({}),
    prepare: () => true,
    verbose: false,
    log: () => undefined,
    isQuitting: () => false,
    isRestarting: () => false,
    rejectPending: () => false,
    onReady: (url: string) => ready.push(url),
    onGone: (title: string) => gone.push(title),
  });
  cleanup.push(() => runtime.stop());
  runtime.start();
  await expect.poll(() => ready.length, { timeout: 40_000, interval: 250 }).toBe(1);
  const first = await readFile(join(paths.stateDir, 'console.json'), 'utf8');
  const firstPid = (JSON.parse(first) as { pid: number }).pid;

  // The host restarts the daemon under the window: the old one dies, the new one
  // publishes its own console.json.
  const replacement = startDaemon(paths);
  try { process.kill(firstPid, 'SIGKILL'); } catch { /* already gone */ }
  await expect.poll(() => ready.length, { timeout: 40_000, interval: 250 }).toBe(2);
  const second = JSON.parse(await readFile(join(paths.stateDir, 'console.json'), 'utf8')) as { pid: number; url: string };
  expect(second.url).not.toBe('');

  // No modal, no quit: the reader's window simply talks to the new daemon.
  expect(gone).toEqual([]);
  expect(replacement.pid).toBeDefined();
}, 120_000);

test('a daemon that is not replaced is started again by the window itself', async () => {
  const { paths } = await fixture();
  // The desktop runtime is plain JavaScript on purpose (no Electron import), so it
  // has no type declarations to import from a test.
  // @ts-expect-error plain-JS module
  const { createDaemonRuntime } = await import('../../desktop/daemon-runtime.mjs');
  const gone: string[] = [];
  const ready: string[] = [];
  const runtime = createDaemonRuntime({
    paths: () => paths,
    bin: () => paths.serverEntry,
    secrets: () => ({}),
    prepare: () => true,
    verbose: false,
    log: () => undefined,
    isQuitting: () => false,
    isRestarting: () => false,
    rejectPending: () => false,
    onReady: (url: string) => ready.push(url),
    onGone: (title: string) => gone.push(title),
  });
  cleanup.push(() => runtime.stop());
  runtime.start();
  await expect.poll(() => ready.length, { timeout: 40_000, interval: 250 }).toBe(1);
  const firstPid = (JSON.parse(await readFile(join(paths.stateDir, 'console.json'), 'utf8')) as { pid: number }).pid;

  // Nothing replaces it this time: the runtime has to bring one back rather than
  // tell the person the daemon stopped.
  try { process.kill(firstPid, 'SIGKILL'); } catch { /* already gone */ }
  await expect.poll(() => ready.length, { timeout: 60_000, interval: 250 }).toBe(2);
  expect(gone).toEqual([]);
}, 120_000);
