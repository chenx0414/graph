import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';
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
  const readRoots = [...new Set([
    ...resolved.extensions.map(resource => resource.metadata.baseDir).filter((value): value is string => typeof value === 'string' && value.length > 0),
    ...entries.map(entry => dirname(entry)),
  ])];
  const version = await packageVersionAt(entries[0]!, npmSourceName(input.source));
  return { entries, readRoots, version };
}

export interface PiExtensionSourceStatus {
  /** The version the resolved package currently has on disk. */
  installed: string | null;
  /** The newest version the declared source resolves to, or null when the source is not npm. */
  latest: string | null;
  available: boolean;
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
  const status: PiExtensionSourceStatus = {
    installed,
    latest,
    available: Boolean(name && installed && latest && installed !== latest),
  };
  statusCache.set(input.source, { at: Date.now(), status });
  return status;
}

/**
 * Install or upgrade a source the way `pi` itself does it: an explicit version reinstalls that
 * spec, an open range or a bare name moves to the newest one.
 */
export async function updatePiExtensionSource(input: { source: string; cwd: string; agentDir: string }): Promise<{ updated: boolean; version: string | null }> {
  const resolved = await resolvePiExtensionSource(input);
  const entry = resolved.entries[0]!;
  const root = installRootOf(entry);
  if (!root) throw new RuntimeError('capability_unavailable', `Pi extension source ${input.source} has no npm install root to update`);
  const spec = input.source.slice(4).trim();
  const name = npmSourceName(input.source);
  const target = name && spec.length > name.length ? spec : `${name ?? spec}@latest`;
  await run('npm', ['install', target], { cwd: root, env: process.env, timeout: 300_000 });
  statusCache.delete(input.source);
  return { updated: true, version: await packageVersionAt(entry, name) };
}
