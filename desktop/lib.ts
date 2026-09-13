/** Pure desktop-app helpers; the Electron glue in main.mjs stays thin. */
import { dirname, isAbsolute, join, resolve } from 'node:path';

export interface AppPaths {
  root: string;
  stateDir: string;
  configPath: string;
  secretsPath: string;
  serverEntry: string;
  webDir: string;
}

/** Layout for dev (`electron .` in the repo) and packaged builds (extraResources). */
export function resolveAppPaths(input: {
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  userData: string;
}): AppPaths {
  const root = input.isPackaged ? resolve(input.resourcesPath) : resolve(input.appPath);
  return {
    root,
    stateDir: join(input.userData, 'state'),
    configPath: join(input.userData, 'graph.config.json'),
    secretsPath: join(input.userData, 'secrets.json'),
    serverEntry: join(root, 'src/server/cli.ts'),
    webDir: input.isPackaged ? join(root, 'web') : join(root, 'dist/web'),
  };
}

/** Daemon arguments for one app launch; port 0 lets the daemon pick a free port. */
export function daemonArgs(input: {
  paths: AppPaths;
  port: number;
  mode: 'view' | 'execute';
  hasConfig: boolean;
}): string[] {
  const args = [
    '--state-dir', input.paths.stateDir,
    '--web-dir', input.paths.webDir,
    '--port', String(input.port),
  ];
  if (input.hasConfig) args.push('--config', input.paths.configPath);
  if (input.mode === 'execute') args.push('--execute');
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

/** Execute mode needs at least one model and every referenced secret resolvable. */
export function resolveDaemonMode(
  config: unknown,
  env: Record<string, string | undefined>,
  secrets: Record<string, string>,
): 'view' | 'execute' {
  if (!config || typeof config !== 'object') return 'view';
  const models = (config as { models?: { entries?: unknown } }).models;
  const entries = models?.entries;
  if (!Array.isArray(entries) || entries.length === 0) return 'view';
  const credentials = (config as { credentials?: unknown }).credentials;
  if (!credentials || typeof credentials !== 'object') return 'view';
  for (const credential of Object.values(credentials as Record<string, unknown>)) {
    const ref = (credential as { secretRef?: unknown } | null)?.secretRef;
    if (typeof ref !== 'string' || ref.length === 0) return 'view';
    if (env[ref] === undefined && secrets[ref] === undefined) return 'view';
  }
  return 'execute';
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

export function saveSecrets(
  path: string,
  codec: SecretCodec,
  secrets: Record<string, string>,
  writeFile: (path: string, data: string) => void,
): boolean {
  if (!codec.isEncryptionAvailable()) return false;
  const entries: Record<string, string> = {};
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

/** Last non-empty lines, for bounded error dialogs. */
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
