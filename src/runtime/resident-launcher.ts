import { existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import type { CapabilityOperation } from './capability-bundle.ts';
import { nodeReadPaths } from './capabilities.ts';
import { developerPath } from './developer-path.ts';
import { graphApplicationRoot } from './graph-root.ts';
import type { PiWorkerConfig } from './pi-process.ts';
import type { ResidentHostOptions } from './resident-host.ts';
import { acquireRestrictedExecutor } from './restricted-process.ts';
import { graphNodeRuntime } from './workspace-command.ts';

async function extensionRoot(entry: string): Promise<string> {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'capability.json'))) return realpath(directory);
    directory = dirname(directory);
  }
  return realpath(dirname(entry));
}

/** Bind the resident protocol to the same permission executor used by capability commands. */
export function residentLauncher(options: {
  config: PiWorkerConfig; configPath: string; workerEntry: string;
  operation: Pick<CapabilityOperation, 'readRoots' | 'writeRoots' | 'unixSockets' | 'env' | 'networkDomains' | 'allowUnrestrictedNetwork' | 'allowLocalBinding'>; access?: ResolvedAccessPolicy;
}): NonNullable<ResidentHostOptions['launch']> {
  return async callbacks => {
    const { config, operation, access } = options;
    const scratch = join(config.stateDir, 'process-scratch');
    await mkdir(scratch, { recursive: true, mode: 0o700 });
    const runtime = graphNodeRuntime();
    // Capture the approved directory once; cwd must use the same pinned spelling as its grants.
    const workspace = await realpath(config.workspace);
    const extensions = await Promise.all(config.piExtensionPaths.map(extensionRoot));
    const reads = await Promise.all([
      graphApplicationRoot(), workspace, config.stateDir, options.configPath,
      ...config.skillPaths, ...(config.skillFolder ? [config.skillFolder] : []),
      ...extensions, ...operation.readRoots, ...operation.writeRoots,
      ...operation.unixSockets, ...nodeReadPaths(runtime.execPath, runtime.electron),
    ].map(path => realpath(path)));
    const writes = await Promise.all([workspace, config.stateDir, ...operation.writeRoots,
      ...operation.unixSockets].map(path => realpath(path)));
    const env: Record<string, string> = { ...operation.env, ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) };
    if (env.PATH) env.PATH = developerPath([dirname(runtime.execPath), ...env.PATH.split(':'), '/usr/bin', '/bin'].join(':'));
    const acquired = await acquireRestrictedExecutor();
    let spawned = false;
    const started = Promise.withResolvers<Awaited<ReturnType<NonNullable<ResidentHostOptions['launch']>>>['control']>();
    const exited = acquired.executor.run({
      broker: { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
      cwd: workspace, scratchDir: await realpath(scratch), executable: runtime.execPath,
      args: [options.workerEntry, options.configPath], readPaths: [...new Set(reads)], writePaths: [...new Set(writes)],
      ...(access?.filesystem.read === 'host' ? { filesystem: 'host', unsandboxed: true,
        protectedPathExceptions: [config.stateDir], protectedReadPathExceptions: [...config.skillPaths, ...extensions] } : {}),
      ...(access?.protectedPaths.length ? { protectedPaths: access.protectedPaths } : {}),
      ...(access?.filesystem.gitMetadata === 'writable' ? { allowGitMetadataWritesAll: true } : {}),
      env, networkDomains: [...operation.networkDomains],
      allowUnrestrictedNetwork: operation.allowUnrestrictedNetwork,
      allowLocalBinding: operation.allowLocalBinding,
      unixSockets: [...operation.unixSockets],
      allowAllUnixSockets: access?.piExtensions.unixSockets === 'all',
      allowAppleEvents: access?.piExtensions.appleEvents ?? false,
      keepStdinOpen: true,
      onSpawn: control => { spawned = true; started.resolve(control); },
      onWorkerMessage: callbacks.message,
    }).then(result => {
      const error = new Error(result.stderr.trim() || `resident worker exited (code ${result.code ?? 'signal'})`);
      if (!spawned) started.reject(error);
      callbacks.exit(error);
    }, error => {
      if (!spawned) started.reject(error);
      callbacks.exit(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => acquired.release());
    return { control: await started.promise, exited };
  };
}
