/**
 * The isolated instance `desktop-crash-recovery.test.ts` drives: its own copy
 * of the checkout, its own `HOME` and `GRAPH_APP_USER_DATA`, its own daemon
 * port, and a keeper as the app's parent.
 *
 * Nothing here mocks a component this product owns: the Electron binary, the Go
 * daemon, sqlite state, the `bash` lanes and the keeper are real. The one
 * stand-in is the model endpoint, which is what a test is allowed to control.
 *
 * `desktop-crash-recovery.instance.ts` owns the machine rules around it: one
 * Electron instance at a time, a bounded number of start-up attempts, and the
 * checks that the user's own app is untouched on both sides of every launch.
 */
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, cp, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { chromium, type Browser, type Page } from 'playwright';
import { build } from 'vite';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';

const run = promisify(execFile);

export const electronBinary: string = createRequire(import.meta.url)('electron');
export const repoRoot = process.cwd();
export const keeperPath = join(repoRoot, 'desktop/keeper.mjs');
/** The user's own app: this record is the thing the test must not touch. */
export const userConsolePath = join(homedir(), 'Library/Application Support/Graph/state/console.json');
/** The pids the acceptance names as the running Graph.app. */
export const RUNNING_APP_PIDS = [3329, 3331];

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The same seatbelt probe the browser helper uses - one mechanism, not two.
 * `tests/helpers/host-browser.ts` (commit e710b928) and this suite must agree on
 * "is this process sandboxed", or one of them would start Electron in a context
 * where the other refuses to.
 */
export { isSandboxed } from '../helpers/host-browser.ts';

export const readJsonSync = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

export const alive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
};

export async function waitFor<T>(
  read: () => T | undefined | Promise<T | undefined>,
  label: string,
  timeout = 60_000,
  /** Returns a reason to stop waiting early - a failure that can no longer heal. */
  abort?: () => string | undefined,
): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    const stopped = abort?.();
    if (stopped) throw new Error(`stopped waiting for ${label}: ${stopped}`);
    try {
      const value = await read();
      if (value !== undefined) return value;
    } catch (error) { last = error; }
    await sleep(150);
  }
  throw new Error(`timed out after ${timeout}ms waiting for ${label}${last ? ` (last error: ${String(last)})` : ''}`);
}

export interface LaneLine { kind: 'start' | 'end'; lane: string; at: number }

/**
 * The stamps the lanes wrote, in the order bash appended them.
 *
 * A stamp that is not a millisecond number is an error, not a `NaN`: the whole a4
 * argument is "this lane finished after the app was killed", and a `NaN` there
 * would be a failure that reads like a machine problem. (Measured once: an
 * unquoted `Date.now()` in the shell made the stamp empty and this reader turned
 * it into `NaN`.)
 */
export const readLanes = (path: string): LaneLine[] => {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => {
    const [kind, lane, at] = line.trim().split(/\s+/);
    const stamp = Number(at);
    if (at === undefined || !Number.isFinite(stamp)) {
      throw new Error(`lane line without a millisecond stamp: ${JSON.stringify(line)}`);
    }
    return { kind: kind === 'end' ? 'end' : 'start', lane: lane ?? '', at: stamp } as LaneLine;
  });
};

export interface LaneTimeline { lane: string; start: number; end: number }

/**
 * Fold the lane stamps into one start/end pair per lane.
 *
 * Throws when a lane is missing or ran twice: after a kill, "the lane ran again"
 * would mean the daemon restarted the work, which is exactly what a4 must not
 * accept, and a `NaN` or a missing pair must not read as a timing problem.
 */
export function laneTimelines(lines: LaneLine[]): LaneTimeline[] {
  const lanes = [...new Set(lines.map(line => line.lane))].sort();
  return lanes.map(lane => {
    const starts = lines.filter(line => line.lane === lane && line.kind === 'start');
    const ends = lines.filter(line => line.lane === lane && line.kind === 'end');
    if (starts.length !== 1 || ends.length !== 1) {
      throw new Error(`${lane} ran ${starts.length} time(s) and finished ${ends.length} time(s)`);
    }
    const start = starts[0]!.at;
    const end = ends[0]!.at;
    if (!(end > start)) throw new Error(`${lane} finished at ${end}, before its start ${start}`);
    return { lane, start, end };
  });
}

/**
 * One graph lane: a real `bash` command that takes long enough to still be
 * running when the app dies. It stamps its own start and end, so the proof that
 * the work never stopped is a second stamp on the far side of the kill.
 */
export function laneModule(id: string, lanesLog: string) {
  // The expression has to reach node as one quoted argument: `-p Date.now()`
  // hands the shell a bare `(` inside the command substitution and the stamp
  // comes out empty.
  const stamp = `"$('${process.execPath}' -e 'console.log(Date.now())')"`;
  const script = `echo "start ${id} ${stamp}" >> "${lanesLog}"; sleep 8; echo "end ${id} ${stamp}" >> "${lanesLog}"`;
  return {
    type: 'operation', trigger: 'each',
    inputs: { job: { protocol: 'data' } },
    outputs: { result: { protocol: 'data' } },
    operation: { action: 'workspace.command', version: 1, command: 'bash', args: ['-lc', script], output: 'result' },
  };
}

export interface InstancePaths {
  root: string;
  source: string;
  userData: string;
  stateDir: string;
  lanesLog: string;
  consolePath: string;
  markerPath: string;
  recordPath: string;
  keeperLogPath: string;
}

export const instancePaths = (root: string): InstancePaths => {
  const source = join(root, 'source');
  const userData = join(root, 'user-data');
  return {
    root, source, userData,
    stateDir: join(userData, 'state'),
    lanesLog: join(root, 'lanes.log'),
    consolePath: join(userData, 'state', 'console.json'),
    markerPath: join(userData, 'crash', 'last-run.json'),
    recordPath: join(userData, 'crash', 'last-crash.json'),
    keeperLogPath: join(userData, 'crash', 'keeper.log'),
  };
};

/**
 * A checkout the isolated app can serve from, plus the config that points both
 * of its models at the controlled endpoint. `dist/web` is built from the live
 * sources, so the window really renders this change.
 */
export async function prepareInstance(paths: InstancePaths, masterBaseUrl: string): Promise<void> {
  await mkdir(paths.source);
  await mkdir(join(paths.root, '.graph'));
  for (const directory of ['src', 'presets', 'docs']) await cp(join(repoRoot, directory), join(paths.source, directory), { recursive: true });
  await cp(join(repoRoot, 'package.json'), join(paths.source, 'package.json'));
  await mkdir(join(paths.source, 'dist'));
  await cp(ensureBackendBinary(), join(paths.source, 'dist/graphd'));
  await writeFile(join(paths.root, '.graph/app-root'), `${paths.source}\n`);
  await build({ configFile: join(repoRoot, 'vite.config.ts'), logLevel: 'error', build: { outDir: join(paths.source, 'dist/web'), emptyOutDir: true } });

  await mkdir(paths.userData, { recursive: true });
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'crash' };
  await writeFile(join(paths.userData, 'graph.config.json'), JSON.stringify({
    version: 1,
    projects: [],
    credentials: { crash: { secretRef: 'GRAPH_CRASH_E2E_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: masterBaseUrl, contextWindow: 32000 },
      { ...credential, id: 'sender', provider: 'graph-worker', modelId: 'worker-model', baseUrl: masterBaseUrl, contextWindow: 32000 },
    ] },
  }));
}

export const freePort = async (): Promise<number> => new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as { port: number }).port;
    server.close(() => resolve(port));
  });
});

export interface KeeperHandle {
  process: ChildProcess;
  output(): string;
  log(): string;
}

/**
 * The keeper is the app's parent, which is the whole point: it survives the kill
 * and it is what turns a death into "code 0" or "signal 9".
 *
 * It is spawned by whoever runs this suite, which must therefore be a host-session
 * process (see `assertNotSandboxed`): a sandboxed runner cannot start Electron and
 * cannot signal it. Starting the keeper itself through LaunchServices was measured
 * this round and rejected - Electron starts, prints its DevTools endpoint, and our
 * app never reaches `whenReady`; see the doc's implementation notes.
 *
 * `--max-restarts=0` is deliberate. This test bounds Electron launches itself;
 * letting the keeper add its own retries would turn one attempt into four
 * crashed processes, and the keeper's crash-loop protection belongs to the
 * product, not to a machine that cannot start Electron at all.
 */
export function launchKeeper(input: { paths: InstancePaths; cdpPort: number; maxRestarts?: number }): KeeperHandle {
  let output = '';
  const keeper = spawn(process.execPath, [
    keeperPath,
    `--app-bin=${electronBinary}`,
    `--max-restarts=${input.maxRestarts ?? 0}`,
    '--',
    `--remote-debugging-port=${input.cdpPort}`,
    // Both switch names exist in this Electron binary (`strings` finds them) and
    // both only govern Chromium's own dialogs and crashpad handler - they cannot
    // silence macOS's system crash dialog, and they are passed because a test
    // should not add avoidable noise of its own.
    '--disable-breakpad',
    '--noerrdialogs',
  ], {
    env: {
      ...process.env,
      HOME: input.paths.root,
      GRAPH_APP_USER_DATA: input.paths.userData,
      GRAPH_RSI_ROOT: join(input.paths.root, 'stale'),
      GRAPH_APP_DEBUG: '1',
      GRAPH_APP_BACKGROUND: '1',
      GRAPH_CRASH_E2E_KEY: 'crash-e2e-synthetic',
      ELECTRON_RUN_AS_NODE: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  keeper.stdout?.on('data', chunk => { output += String(chunk); });
  keeper.stderr?.on('data', chunk => { output += String(chunk); });
  keeper.on('exit', code => { output += `[keeper exited ${code}]\n`; });
  return {
    process: keeper,
    output: () => output,
    log: () => { try { return readFileSync(input.paths.keeperLogPath, 'utf8'); } catch { return ''; } },
  };
}

/**
 * The window over CDP. Playwright cannot own the app process here - the keeper
 * has to be its parent - so the page is reached through the debugging port the
 * isolated instance was started with.
 */
export async function connectWindow(cdpPort: number, label: string): Promise<{ browser: Browser; page: Page }> {
  return waitFor(async () => {
    const candidate = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`, { timeout: 5_000 }).catch(() => undefined);
    if (!candidate) return undefined;
    const page = candidate.contexts().flatMap(context => context.pages()).find(item => item.url().startsWith('http://127.0.0.1:'));
    if (!page) { await candidate.close().catch(() => undefined); return undefined; }
    return { browser: candidate, page };
  }, `${label}: the app window over CDP`, 90_000);
}

/** Kept here because both the fixture and the instance rules write evidence. */
export const diagnosticReportsDir = (): string => join(homedir(), 'Library/Logs/DiagnosticReports');
