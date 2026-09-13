import { open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../core/types.ts';
import { assertCredentialGroups, loadGraphConfig, parseGraphConfig, type GraphConfig } from './config.ts';

export interface ConfigSnapshot {
  revision: number;
  config: GraphConfig;
}

/** Credential view safe for the browser: no secret value can ever be included. */
export function sanitizeConfig(config: GraphConfig, env: Record<string, string | undefined>) {
  return {
    path: config.path,
    configured: config.configured,
    projects: config.projects,
    models: config.models,
    credentials: Object.fromEntries(Object.entries(config.credentials).map(([id, credential]) => [id, {
      secretRef: credential.secretRef,
      configured: Boolean(env[credential.secretRef]?.trim()),
      ...(credential.displayName ? { displayName: credential.displayName } : {}),
      ...(credential.sharedLimitGroupId ? { sharedLimitGroupId: credential.sharedLimitGroupId } : {}),
    }])),
    limits: config.limits,
  };
}

async function readRevision(path: string) {
  const text = await readFile(path, 'utf8');
  const raw = JSON.parse(text) as { revision?: unknown };
  if (raw.revision !== undefined && (typeof raw.revision !== 'number' || !Number.isInteger(raw.revision) || raw.revision < 0)) {
    throw new RuntimeError('invalid_config', `${path}: revision must be a nonnegative integer`);
  }
  return { revision: typeof raw.revision === 'number' ? raw.revision : 0, document: raw };
}

/** File-backed configuration with an atomic save, a monotonically increasing
 * revision and a cross-process edit lock. The web layer validates through this
 * service; it never writes the runtime database. */
export async function openConfigStore(path: string) {
  const lockPath = `${path}.lock`;
  let revision = (await readRevision(path)).revision;
  return {
    path,
    revision: () => revision,
    async snapshot(): Promise<ConfigSnapshot> {
      const current = await readRevision(path);
      revision = current.revision;
      return { revision, config: await loadGraphConfig(path) };
    },
    async save(document: unknown, expectedRevision: number, env?: Record<string, string | undefined>) {
      let lock;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        try {
          lock = await open(lockPath, 'wx', 0o600);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
      if (!lock) throw new RuntimeError('config_locked', `Config is locked by another editor: ${path}`);
      try {
        const current = await readRevision(path);
        if (current.revision !== expectedRevision) {
          throw new RuntimeError('config_conflict', `Config changed: expected revision ${expectedRevision}, found ${current.revision}; reload before saving`);
        }
        const next = { ...(document && typeof document === 'object' && !Array.isArray(document) ? document as Record<string, unknown> : {}), version: 1, revision: current.revision + 1 };
        const parsed = parseGraphConfig(next, path);
        // Resolvable credential conflicts must fail before the atomic replace,
        // so a bad save never leaves a config the daemon cannot start from.
        if (env) assertCredentialGroups(parsed, env);
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, path);
        revision = next.revision;
        return { revision, config: parsed };
      } finally {
        await lock.close();
        await rm(lockPath, { force: true });
      }
    },
  };
}

export type ConfigStore = Awaited<ReturnType<typeof openConfigStore>>;
