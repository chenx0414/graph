import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, basename, join, sep, resolve } from 'node:path';
import { promisify } from 'node:util';
import { DefaultPackageManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { RuntimeError } from '../core/types.ts';

export interface ResolvedPiExtensionSource {
  /** Extension entry files the SDK resolved, in its own order. */
  entries: string[];
  /** Directories the loaded extension needs to read (install root plus each entry's folder). */
  readRoots: string[];
  /** The version the resolved package currently has on disk. */
  version: string | null;
}

/**
 * Resolve one Pi extension capability source exactly the way the Pi SDK does it: `npm:<spec>`,
 * a git URL, or a local path. The SDK's own package manager installs it (temporary scope, under
 * `<agentDir>/tmp/extensions`) and reads the package's own `pi.extensions` list, so Graph neither
 * vendors a copy nor hand-writes the entry file.
 */
export async function resolvePiExtensionSource(input: {
  source: string;
  cwd: string;
  agentDir: string;
}): Promise<ResolvedPiExtensionSource> {
  // Every temporary npm source shares the SDK's install root. A snapshot change
  // can be another package's legitimate update, not corruption. Never remove
  // that shared tree while resolving one source or refreshing catalog status.
  // Policy, and the 2026-09-25 incident that produced it: docs/agent/troubleshooting.md,
  // section 共享可变状态与安装根 (serialize by canonical path; a destructive action needs
  // evidence from the affected object, never a static signal).
  return withExtensionInstall(input.agentDir, () => resolveSourceOnce(input));
}

// The daemon owns source resolution and updates. Serialize all of its npm
// mutations by agent directory, not package name, including background refresh.
const extensionInstalls = new Map<string, Promise<void>>();
async function withExtensionInstall<T>(agentDir: string, action: () => Promise<T>): Promise<T> {
  const key = await realpath(agentDir).catch(() => resolve(agentDir));
  const previous = extensionInstalls.get(key) ?? Promise.resolve();
  const result = previous.then(action);
  const settled = result.then(() => undefined, () => undefined);
  extensionInstalls.set(key, settled);
  try { return await result; }
  finally { if (extensionInstalls.get(key) === settled) extensionInstalls.delete(key); }
}

async function resolveSourceOnce(input: {
  source: string;
  cwd: string;
  agentDir: string;
}): Promise<ResolvedPiExtensionSource> {
  const manager = new DefaultPackageManager({
    cwd: input.cwd,
    agentDir: input.agentDir,
    settingsManager: SettingsManager.inMemory(),
  });
  const resolved = await manager.resolveExtensionSources([input.source], { temporary: true });
  const entries = resolved.extensions.filter(resource => resource.enabled).map(resource => resource.path);
  if (!entries.length) {
    throw new RuntimeError('capability_unavailable', `Pi extension source ${input.source} resolved no extension entry`);
  }
  await ensureRequiredPeers(entries[0]!);
  const readRoots = [...new Set([
    ...resolved.extensions.map(resource => resource.metadata.baseDir).filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...entries.map(entry => dirname(entry)),
    // The restricted worker reads the extension in a sandbox, and a sourced package's own
    // dependencies (its peers and its node_modules) are siblings of the package directory, so
    // the install root has to be readable as well or the extension cannot resolve them.
    ...(installRootFor(entries[0]!) ? [installRootFor(entries[0]!)!] : []),
  ])];
  const version = await packageVersionAt(entries[0]!, npmSourceName(input.source));
  return { entries, readRoots, version };
}

/** The install root npm used for a temporary source: `<root>/node_modules/<pkg>/…`. */
function installRootFor(entry: string): string | undefined {
  let current = dirname(entry);
  while (current !== dirname(current)) {
    if (basename(current) === 'node_modules') return dirname(current);
    current = dirname(current);
  }
  return undefined;
}

/** The nearest package.json at or above one path. */
async function packageManifestAt(start: string): Promise<Record<string, unknown> | undefined> {
  let current = start;
  while (current !== dirname(current)) {
    const file = join(current, 'package.json');
    if (existsSync(file)) {
      try { return JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>; }
      catch { return undefined; }
    }
    current = dirname(current);
  }
  return undefined;
}

/**
 * Relative paths a package declares as its own runtime entry points but does not have on disk.
 * A truncated install — the incident this exists for: a package was present under
 * `node_modules` while its whole `v4/` directory was missing, so the extension that needed it died
 * with `Cannot find module './v4/classic/external.js'` — is invisible to `existsSync` on the
 * directory, so completeness has to be checked per declared target. Type declarations are
 * ignored here: a package may legitimately ship none, and a missing `.d.ts` never stops a load.
 */
export async function packageGaps(dir: string, options: { rootOnly?: boolean } = {}): Promise<string[]> {
  const manifest = (await packageManifestAt(dir)) as Record<string, unknown> | null;
  if (!manifest || typeof manifest !== 'object') return ['package.json'];
  const targets = new Set<string>();
  const collect = (value: unknown): void => {
    if (typeof value === 'string') {
      if (!value.includes('*') && !/\.d\.(ts|mts|cts)$/.test(value)) targets.add(value);
      return;
    }
    if (Array.isArray(value)) { for (const item of value) collect(item); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      // A subpath export (`"./v4/classic/external.js"`) is a real file the package must ship; a
      // custom condition name (`"standard-schema-spec"`) is not a runtime entry for us and may
      // legitimately point at sources the published package leaves out.
      const subpath = key.startsWith('.');
      if (!subpath && !RUNTIME_CONDITIONS.has(key)) continue;
      // `"."` is the package's own root entry, not a subpath: a dependency only has to satisfy it.
      if (options.rootOnly && subpath && key !== '.') continue;
      collect(item);
    }
  };
  collect(manifest.main);
  collect(manifest.module);
  collect(manifest.exports);
  const gaps: string[] = [];
  for (const target of targets) {
    // `main` is often written without a `./` prefix (`ajv` ships `dist/ajv.js`, `cross-spawn`
    // ships `index.js`); only absolute paths and URLs are outside the package.
    if (target.startsWith('/') || /^[a-zA-Z]+:/.test(target)) continue;
    const relative = target.startsWith('./') ? target.slice(2) : target;
    if (!targetExists(dir, relative)) gaps.push(relative);
  }
  return gaps;
}

/** Export conditions that name a runtime entry point; anything else is a publisher's own dialect. */
const RUNTIME_CONDITIONS = new Set(['node', 'import', 'require', 'default', 'module']);

/**
 * Every top-level package in one install root that declares an entry point it does not ship.
 * **Diagnostic only**: neither a gap nor a snapshot difference proves damage — a published package
 * may declare a root entry it never ships (`@modelcontextprotocol/sdk@1.30.1` declares
 * `dist/esm/index.js` and the official tarball has no such file), and a change in that tree can be
 * another source's legitimate update. The install root is shared by every temporary npm source, so
 * resolving one source must never remove it: installs are serialized per agent directory instead
 * (see `withExtensionInstall`).
 */
export async function installRootGaps(root: string): Promise<string[]> {
  const nodeModules = join(root, 'node_modules');
  if (!existsSync(nodeModules)) return [];
  const gaps: string[] = [];
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    const names = entry.startsWith('@')
      ? readdirSync(join(nodeModules, entry)).map(name => `${entry}/${name}`)
      : [entry];
    for (const name of names) {
      const dir = join(nodeModules, name);
      const missing = await packageGaps(dir, { rootOnly: true });
      if (missing.length) gaps.push(`${name}: ${missing.join(', ')}`);
    }
  }
  return gaps;
}

const INSTALL_SNAPSHOT_FILE = '.graph-install.json';

/**
 * One digest per installed package: the sorted list of its files. A diagnostic snapshot, recorded
 * after an install so a test can show that a later resolution left a sibling package untouched.
 */
async function installTree(root: string): Promise<Record<string, string>> {
  const nodeModules = join(root, 'node_modules');
  if (!existsSync(nodeModules)) return {};
  const tree: Record<string, string> = {};
  for (const entry of readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    const names = entry.startsWith('@')
      ? readdirSync(join(nodeModules, entry)).map(name => `${entry}/${name}`)
      : [entry];
    for (const name of names) {
      const files = readdirSync(join(nodeModules, name), { recursive: true, withFileTypes: true })
        .filter(item => item.isFile())
        .map(item => join(item.parentPath, item.name).slice(join(nodeModules, name).length + 1))
        .sort();
      tree[name] = createHash('sha256').update(files.join('\n')).digest('hex');
    }
  }
  return tree;
}

/** Record what is installed now; a diagnostic baseline, never a trigger for deleting anything. */
export async function recordInstallSnapshot(root: string): Promise<void> {
  await writeFile(join(root, INSTALL_SNAPSHOT_FILE), JSON.stringify(await installTree(root)));
}

/**
 * The same resolution Node itself applies to a plain path: the exact file, the file with a
 * runtime extension, or the directory's index. Declaring `main: "./index"` while shipping
 * `index.js` is perfectly normal (`ms` does exactly that), and a gap check that called such a
 * package broken would reinstall a healthy tree — and, worse, could be mistaken for a reason to
 * block a load.
 */
function targetExists(dir: string, relative: string): boolean {
  for (const suffix of ['', '.js', '.mjs', '.cjs', '.json', '/index.js', '/index.mjs', '/index.cjs', '/index.json']) {
    if (existsSync(join(dir, `${relative}${suffix}`))) return true;
  }
  return false;
}

/**
 * The Pi SDK installs a source with `--omit=peer`, and the host supplies only
 * `@earendil-works/*` to loaded extensions, so a plain non-optional peer such as
 * `zod` would never resolve and the extension could not load at all. Install those
 * peers into the same root and verify them afterwards; an already complete peer is a no-op.
 * A partial npm extraction in that shared root is the real failure this guards: the incident left
 * `zod` present but stripped of its whole `v4/` directory, with another package's declared entry
 * missing in the same tree, so the presence of a directory proves nothing.
 */
export async function ensureRequiredPeers(entry: string): Promise<void> {
  const root = installRootFor(entry);
  if (!root) return;
  const manifest = await packageManifestAt(dirname(entry));
  const peers = (manifest?.peerDependencies ?? {}) as Record<string, string>;
  const meta = (manifest?.peerDependenciesMeta ?? {}) as Record<string, { optional?: boolean }>;
  const required = Object.keys(peers)
    .filter(name => meta[name]?.optional !== true && !name.startsWith('@earendil-works/'));
  if (!required.length) return;
  const incomplete = async (name: string) => {
    const dir = join(root, 'node_modules', name);
    return !existsSync(dir) || (await packageGaps(dir)).length > 0;
  };
  const broken: string[] = [];
  for (const name of required) if (await incomplete(name)) broken.push(name);
  if (!broken.length) return;
  // `--prefer-online` keeps a stale entry in npm's own cache from handing back the very tree that
  // made the peer unloadable. Repair stays best effort on purpose: a static gap check can be wrong
  // about an exotic export map, and turning that guess into a thrown error would block a session
  // that would otherwise load — the load itself stays the authority.
  await run('npm', ['install', ...broken.map(name => `${name}@${peers[name]}`), '--prefix', root, '--omit=dev', '--no-save', '--no-audit', '--no-fund', '--prefer-online'], { timeout: 300_000 });
}

export interface PiExtensionSourceStatus {
  /** The version the resolved package currently has on disk. */
  installed: string | null;
  /** The newest version the declared source resolves to, or null when the source is not npm. */
  latest: string | null;
  available: boolean;
  /**
   * Declared entry points missing from this source's install root. A diagnostic only: a published
   * package may declare an entry it never ships (`@modelcontextprotocol/sdk@1.30.1`), and the root
   * is shared by every temporary npm source. Nothing is ever deleted or rebuilt because of this.
   */
  installGaps: string[];
}

/** One source-bearing capability plus what its registry says about it. */
export interface PiExtensionUpdate extends PiExtensionSourceStatus {
  id: string;
  version: string;
  source: string;
  error?: string;
}

const run = promisify(execFile);
const statusCache = new Map<string, { at: number; status: PiExtensionSourceStatus }>();
const STATUS_CACHE_MS = 60_000;

/** The package name inside an `npm:` source; null for git and local sources. */
export function npmSourceName(source: string): string | null {
  const spec = source.startsWith('npm:') ? source.slice(4).trim() : '';
  if (!spec) return null;
  const at = spec.lastIndexOf('@');
  return (at > 0 ? spec.slice(0, at) : spec).trim() || null;
}

/** The version in the nearest package.json above an entry; `name` narrows which manifest counts. */
async function packageVersionAt(entry: string, name: string | null): Promise<string | null> {
  let directory = dirname(entry);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, 'package.json');
    if (existsSync(candidate)) {
      try {
        const manifest = JSON.parse(await readFile(candidate, 'utf8')) as { name?: unknown; version?: unknown };
        const matches = name === null || manifest.name === name;
        if (matches && typeof manifest.version === 'string') return manifest.version;
      } catch { /* keep walking up */ }
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/** The install root npm wrote: the folder that owns the `node_modules` the entry lives in. */
function installRootOf(entry: string): string | null {
  const at = entry.indexOf(`${sep}node_modules${sep}`);
  return at > 0 ? entry.slice(0, at) : null;
}

async function npmLatest(spec: string, cwd: string): Promise<string | null> {
  try {
    const { stdout } = await run('npm', ['view', spec, 'version', '--json'], { cwd, env: process.env, timeout: 30_000 });
    const value = JSON.parse(stdout.trim()) as unknown;
    if (typeof value === 'string') return value;
    if (Array.isArray(value) && typeof value[value.length - 1] === 'string') return value[value.length - 1] as string;
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether a source has a newer version than the one on disk. The Pi SDK's own
 * `checkForAvailableUpdates()` only inspects packages configured in its settings, and a
 * capability source is resolved in temporary scope, so Graph asks npm itself.
 */
export async function piExtensionSourceStatus(input: { source: string; cwd: string; agentDir: string }): Promise<PiExtensionSourceStatus> {
  const cached = statusCache.get(input.source);
  if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status;
  const resolved = await resolvePiExtensionSource(input);
  const name = npmSourceName(input.source);
  const installed = await packageVersionAt(resolved.entries[0]!, name);
  const latest = name ? await npmLatest(input.source.slice(4).trim(), input.cwd) : null;
  const root = installRootFor(resolved.entries[0]!);
  let installGaps: string[] = [];
  // Best effort on purpose: a diagnostic that throws would turn "we could not look" into "the
  // extension is broken".
  if (root) { try { installGaps = await installRootGaps(root); } catch { installGaps = []; } }
  const status: PiExtensionSourceStatus = {
    installed,
    latest,
    available: Boolean(name && installed && latest && installed !== latest),
    installGaps,
  };
  statusCache.set(input.source, { at: Date.now(), status });
  return status;
}

/**
 * Install or upgrade a source the way `pi` itself does it: an explicit version reinstalls that
 * spec, an open range or a bare name moves to the newest one.
 */
export async function updatePiExtensionSource(input: { source: string; cwd: string; agentDir: string }): Promise<{ updated: boolean; version: string | null }> {
  return withExtensionInstall(input.agentDir, async () => {
    const resolved = await resolveSourceOnce(input);
    const entry = resolved.entries[0]!;
    const root = installRootOf(entry);
    if (!root) throw new RuntimeError('capability_unavailable', `Pi extension source ${input.source} has no npm install root to update`);
    const spec = input.source.slice(4).trim();
    const name = npmSourceName(input.source);
    const target = name && spec.length > name.length ? spec : `${name ?? spec}@latest`;
    await run('npm', ['install', target], { cwd: root, env: process.env, timeout: 300_000 });
    statusCache.delete(input.source);
    return { updated: true, version: await packageVersionAt(entry, name) };
  });
}
