/** Pure desktop-app helpers; the Electron glue in main.mjs stays thin. */
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface AppPaths {
  root: string;
  /** Checkout the daemon actually runs from; equals root unless the app root file or
   * GRAPH_RSI_ROOT redirects it. */
  sourceRoot: string;
  stateDir: string;
  graphHome: string;
  configPath: string;
  secretsPath: string;
  serverEntry: string;
  webDir: string;
}

export type ResourceLibraryKind = 'skills' | 'mcp' | 'pi-extensions' | 'agent-md' | 'prompts';

/** Allowlisted local storage roots for resource-library folder actions. */
export function resourceDirectory(graphHome: string, kind: ResourceLibraryKind): string {
  if (kind === 'prompts') return join(graphHome, 'prompts');
  return join(graphHome, 'capabilities', kind);
}

/** Layout for dev (`electron .` in the repo) and packaged builds (app dir). */
export function resolveAppPaths(input: {
  appPath: string;
  isPackaged: boolean;
  userData: string;
  graphHome?: string;
  /** Run the daemon from this source checkout instead of the app bundle. */
  sourceRoot?: string;
}): AppPaths {
  const root = resolve(input.appPath);
  const sourceRoot = input.sourceRoot ? resolve(input.sourceRoot) : root;
  return {
    root,
    sourceRoot,
    stateDir: join(input.userData, 'state'),
    graphHome: resolve(input.graphHome ?? join(process.env.HOME ?? input.userData, '.graph')),
    configPath: join(input.userData, 'graph.config.json'),
    secretsPath: join(input.userData, 'secrets.json'),
    serverEntry: join(sourceRoot, 'src/server/cli.ts'),
    webDir: input.sourceRoot
      ? join(sourceRoot, 'dist/web')
      : input.isPackaged ? join(root, 'web') : join(root, 'dist/web'),
  };
}

/** Where the app records the checkout it runs the daemon from. */
export function appRootFilePath(graphHome: string): string {
  return join(graphHome, 'app-root');
}

/** The checkout the daemon executes. The root file is the durable setting: a launch from Finder
 * carries no environment, so the app has to read that choice from disk. GRAPH_RSI_ROOT stays the
 * override for a dev run, and a root that cannot serve the console is skipped rather than leaving
 * the window blank. The named checkout is the product line, because it is also the tree a
 * self-improvement change edits and the tree `app:build` rebuilds. */
export function resolveSourceRoot(input: {
  fileRoot?: string;
  envRoot?: string;
  canServe: (root: string) => boolean;
}): string | undefined {
  for (const candidate of [input.fileRoot, input.envRoot]) {
    const value = candidate?.trim();
    if (!value) continue;
    const root = resolve(value);
    if (input.canServe(root)) return root;
  }
  return undefined;
}

export function trayIconPath(root: string): string {
  return join(root, 'build', 'trayTemplate.png');
}

export interface TrayMenuItem {
  label: string;
  enabled?: boolean;
  separator?: boolean;
  action?: 'open' | 'quit';
}

/** Menu definition for the macOS status item; actions stay in main. */
export function trayMenuItems(openTotal: number): TrayMenuItem[] {
  return [
    { label: '打开控制台', action: 'open' },
    { label: openTotal > 0 ? `待处理问题 ${openTotal}` : '没有待处理问题', enabled: false },
    { label: '', separator: true },
    { label: '退出 Graph', action: 'quit' },
  ];
}

/** Daemon arguments for one app launch; port 0 lets the daemon pick a free port. */
export function daemonArgs(input: {
  paths: AppPaths;
  port: number;
  mode: 'view' | 'execute';
  hasConfig: boolean;
  /** Start with execute intent before credentials resolve; the bridge applies
   * saved keychain secrets and config to the same daemon. */
  dynamic?: boolean;
}): string[] {
  const args = [
    '--state-dir', input.paths.stateDir,
    '--graph-home', input.paths.graphHome,
    '--web-dir', input.paths.webDir,
    '--port', String(input.port),
  ];
  if (input.hasConfig) args.push('--config', input.paths.configPath);
  if (input.mode === 'execute') args.push('--execute');
  if (input.dynamic) args.push('--dynamic');
  return args;
}

/** Extract the loopback address from the daemon banner; rejects non-loopback hosts. */
export function parseBannerAddress(text: string): string | undefined {
  const match = /^ {2}address: {3}(http:\/\/\S+)\s*$/m.exec(text);
  if (!match) return undefined;
  try {
    const url = new URL(match[1]!);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/** Execute mode needs at least one model whose credential resolves; models
 * with missing credentials stay disabled instead of forcing view-only. */
export function resolveDaemonMode(
  config: unknown,
  env: Record<string, string | undefined>,
  secrets: Record<string, string>,
): 'view' | 'execute' {
  if (!config || typeof config !== 'object') return 'view';
  const entries = (config as { models?: { entries?: unknown } }).models?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return 'view';
  const credentials = (config as { credentials?: unknown }).credentials;
  if (!credentials || typeof credentials !== 'object') return 'view';
  for (const model of entries) {
    const credentialId = (model as { credentialId?: unknown } | null)?.credentialId;
    if (typeof credentialId !== 'string' || credentialId.length === 0) continue;
    const ref = (credentials as Record<string, { secretRef?: unknown }>)[credentialId]?.secretRef;
    if (typeof ref !== 'string' || ref.length === 0) continue;
    if (env[ref] !== undefined || secrets[ref] !== undefined) return 'execute';
  }
  return 'view';
}

export interface SecretCodec {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

/** Keychain-backed secrets file: env-var name -> base64 ciphertext. */
export function loadSecrets(path: string, codec: SecretCodec, readFile: (path: string) => string): Record<string, string> {
  if (!codec.isEncryptionAvailable()) return {};
  let raw: string;
  try {
    raw = readFile(path);
  } catch {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  const entries = (parsed as { entries?: unknown } | null)?.entries;
  if (!entries || typeof entries !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [ref, value] of Object.entries(entries as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    try {
      const plain = codec.decryptString(Buffer.from(value, 'base64'));
      if (plain.length > 0) result[ref] = plain;
    } catch {
      // A stale entry must not block the app; the wizard can rewrite it.
    }
  }
  return result;
}

/**
 * The store's raw entries, still encrypted. A write is a read-modify-write
 * because an entry this app instance cannot decrypt is still an entry the user
 * saved: rewriting the file from the in-memory map alone would erase it.
 */
export function loadRawSecretEntries(path: string, readFile: (path: string) => string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFile(path)) as { entries?: unknown } | null;
    const entries = parsed?.entries;
    if (!entries || typeof entries !== 'object') return {};
    const result: Record<string, string> = {};
    for (const [ref, value] of Object.entries(entries as Record<string, unknown>)) {
      if (typeof value === 'string') result[ref] = value;
    }
    return result;
  } catch {
    return {};
  }
}

export function saveSecrets(
  path: string,
  codec: SecretCodec,
  secrets: Record<string, string>,
  writeFile: (path: string, data: string) => void,
  /** `raw` is the file as it is now; `touched` are the refs this call means to
   * write or revoke. Anything else in `raw` is carried over untouched. */
  preserve?: { raw: Record<string, string>; touched: string[] },
): boolean {
  if (!codec.isEncryptionAvailable()) return false;
  const entries: Record<string, string> = { ...(preserve?.raw ?? {}) };
  for (const ref of preserve?.touched ?? []) delete entries[ref];
  for (const [ref, value] of Object.entries(secrets)) {
    entries[ref] = codec.encryptString(value).toString('base64');
  }
  writeFile(path, `${JSON.stringify({ version: 1, entries }, null, 2)}\n`);
  return true;
}

export interface TaskSummaryLite {
  id: string;
  request: string;
  status: string;
  openQuestions?: number;
}

export interface NotificationDecision {
  taskId: string;
  title: string;
  body: string;
}

export interface NotificationState {
  primed: boolean;
  questions: Record<string, number>;
  status: Record<string, string>;
}

/** Diff two task snapshots into macOS notifications: new open questions and
 * terminal transitions. The first snapshot only primes state. */
export function taskNotifications(
  state: NotificationState,
  tasks: TaskSummaryLite[],
): { state: NotificationState; notifications: NotificationDecision[]; openTotal: number } {
  const notifications: NotificationDecision[] = [];
  const questions: Record<string, number> = {};
  const status: Record<string, string> = {};
  let openTotal = 0;
  for (const task of tasks) {
    const open = Number.isFinite(task.openQuestions) ? Math.max(0, Number(task.openQuestions)) : 0;
    openTotal += open;
    if (state.primed) {
      const previous = state.questions[task.id] ?? 0;
      if (open > previous) {
        notifications.push({ taskId: task.id, title: '任务需要处理', body: task.request.slice(0, 80) });
      }
      const was = state.status[task.id];
      if (was && was !== task.status && (task.status === 'completed' || task.status === 'failed')) {
        notifications.push({ taskId: task.id, title: task.status === 'completed' ? '任务已完成' : '任务失败', body: task.request.slice(0, 80) });
      }
    }
    questions[task.id] = open;
    status[task.id] = task.status;
  }
  return { state: { primed: true, questions, status }, notifications, openTotal };
}

/** Decide whether a pending self-improvement reload can run right now. */
export function rsiRestartDecision(
  status: unknown,
  restarting: boolean,
): { id: string } | null {
  if (restarting) return null;
  if (!status || typeof status !== 'object') return null;
  const body = status as { pendingRestart?: unknown; canRestart?: unknown };
  const pending = body.pendingRestart;
  if (!pending || typeof pending !== 'object') return null;
  const id = (pending as { id?: unknown }).id;
  if (typeof id !== 'string' || !id) return null;
  if (body.canRestart !== true) return null;
  return { id };
}

/** Last non-empty lines, for bounded error dialogs. */
/** Validate and apply one `graph:save-secret` request. `value === null` is an
 * explicit revocation and must be expressible through the IPC bridge; an empty
 * string is not a revocation and is rejected. */
export function applySecretRequest(
  secrets: Record<string, string>,
  ref: unknown,
  value: unknown,
): { ok: false; message: string } | { ok: true; secrets: Record<string, string>; revoked: boolean } {
  if (typeof ref !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) return { ok: false, message: 'invalid secret reference' };
  if (value === null) {
    const next = { ...secrets };
    delete next[ref];
    return { ok: true, secrets: next, revoked: true };
  }
  if (typeof value !== 'string' || !value.trim()) return { ok: false, message: 'invalid secret value' };
  return { ok: true, secrets: { ...secrets, [ref]: value.trim() }, revoked: false };
}

export function tailText(text: string, lines: number): string {
  return text.split('\n').filter(line => line.trim().length > 0).slice(-lines).join('\n');
}

export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Keep paths absolute when passing them to the daemon from the app. */
export function absolutePaths(paths: AppPaths): AppPaths {
  const ensure = (value: string) => (isAbsolute(value) ? value : resolve(value));
  return {
    ...paths,
    root: ensure(paths.root),
    sourceRoot: ensure(paths.sourceRoot),
    stateDir: ensure(paths.stateDir),
    configPath: ensure(paths.configPath),
    secretsPath: ensure(paths.secretsPath),
    serverEntry: ensure(paths.serverEntry),
    webDir: ensure(paths.webDir),
  };
}

export function configDir(paths: AppPaths): string {
  return dirname(paths.configPath);
}

/** The config store only exists when the daemon is started with a config
 * path, so the app seeds the smallest valid document before first launch.
 * `exists` keeps the helper filesystem-free for tests. */
export function ensureConfigFile(
  configPath: string,
  exists: (path: string) => boolean,
  write: (path: string, data: string) => void,
): boolean {
  if (exists(configPath)) return true;
  try {
    write(configPath, `${JSON.stringify({ version: 1, projects: [] }, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/** Persist only an internal route, never the old daemon port or arbitrary URL. */
export function consoleRoute(url: string): string | null {
  try {
    const hash = new URL(url).hash;
    return /^#\/(?:conversations|tasks)\/[a-zA-Z0-9-]+$/.test(hash) ? hash : null;
  } catch { return null; }
}
export function restoreConsoleRoute(base: string, route: string | null): string {
  const url = new URL(base);
  if (route && consoleRoute(`http://127.0.0.1/${route}`)) url.hash = route;
  return url.toString();
}

/** A same-port daemon reload keeps the console address. Electron's `loadURL` of
 * that exact address is an in-place navigation: it fails with ERR_FAILED and
 * never requests `GET /`, so the new session cookie is never installed and the
 * page stays on 重连中. Same document must reload; a new port must navigate. */
export function consoleReloadAction(currentUrl: string, nextUrl: string): 'reload' | 'navigate' {
  try {
    const current = new URL(currentUrl);
    const next = new URL(nextUrl);
    if (current.origin === next.origin && current.pathname === next.pathname && current.search === next.search) return 'reload';
  } catch { /* A blank or malformed current page still needs a real navigation. */ }
  return 'navigate';
}
