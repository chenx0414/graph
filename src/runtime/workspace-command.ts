import { accessSync, constants, existsSync } from 'node:fs';
import { mkdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RuntimeError } from '../core/types.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { acquireRestrictedExecutor, type RestrictedGate } from './restricted-process.ts';

const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show']);
const INLINE_NODE = new Set(['-e', '--eval', '-p', '--print', '--input-type']);
// `/usr/bin/git` is a shim that resolves the developer directory at runtime; the
// sandbox cannot follow it. Prefer the concrete Command Line Tools binary.
const GIT = ['/Library/Developer/CommandLineTools/usr/bin/git', '/usr/bin/git'].find(existsSync) ?? '/usr/bin/git';

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Loopback resolver shim for sandboxed node checks; readable in both the
 * repository and the packaged app (its directory joins the read grants). */
const RESOLVER_SHIM = fileURLToPath(new URL('./check-resolver.cjs', import.meta.url));

export interface ResolvedCommand {
  executable: string;
  args: string[];
  /** Extra read grants and environment for the spawned process. */
  readPaths?: string[];
  env?: Record<string, string>;
}

/** Name of the environment variable the desktop shell uses to point every
 * helper it spawns at the app's own node runtime. */
export const RUNTIME_NODE_ENV = 'GRAPH_APP_NODE';

/** Node runtime for sandboxed helper processes: the node that hosts Graph
 * itself. A packaged app ships a real node binary (`runtime/node`) and names it
 * in `GRAPH_APP_NODE`; otherwise the binary running Graph is the answer, and
 * inside Electron that is the Electron binary, which runs Node when
 * ELECTRON_RUN_AS_NODE is set and needs read access to the bundle's frameworks.
 * (The Electron binary cannot start inside the OS sandbox because it needs its
 * Helper apps, so helpers are always pointed at the bundled node.) */
export function graphNodeRuntime(env: Record<string, string | undefined> = process.env): { execPath: string; electron?: string | undefined } {
  const bundled = env[RUNTIME_NODE_ENV]?.trim();
  if (bundled) return { execPath: bundled };
  return { execPath: process.execPath, ...(process.versions.electron ? { electron: process.versions.electron } : {}) };
}

export function resolveNodeCommand(
  args: string[],
  runtime: { execPath: string; electron?: string | undefined } = graphNodeRuntime(),
  /** The sandbox needs the shim to reach loopback; a host run does not, and must not be given it. */
  options: { shim?: boolean } = {},
): ResolvedCommand {
  // --require makes the shim run before the check's own modules, and works in
  // Electron's Node mode where NODE_OPTIONS is ignored. `--check` only parses
  // a file and rejects extra options.
  const shim = options.shim === false || args.includes('--check') ? [] : ['--require', RESOLVER_SHIM];
  const shimArgs = [...shim, ...args];
  if (!runtime.electron) return { executable: runtime.execPath, args: shimArgs, ...(shim.length ? { readPaths: [dirname(RESOLVER_SHIM)] } : {}) };
  return {
    executable: runtime.execPath,
    args: shimArgs,
    readPaths: shim.length ? [dirname(RESOLVER_SHIM), dirname(dirname(runtime.execPath))] : [dirname(dirname(runtime.execPath))],
    env: { ELECTRON_RUN_AS_NODE: '1' },
  };
}

/** A conservative allowlist: build/test commands plus read-only Git. */
export function validateWorkspaceCommand(command: string, args: string[]): ResolvedCommand {
  if (command === 'node') {
    if (args.some(arg => INLINE_NODE.has(arg) || arg.startsWith('--eval='))) {
      throw new RuntimeError('permission', 'Inline node evaluation is not allowed in a work copy');
    }
    return resolveNodeCommand(args);
  }
  if (command === 'git') {
    if (!READ_ONLY_GIT.has(args[0] ?? '')) throw new RuntimeError('permission', 'Only read-only Git commands are allowed');
    return { executable: GIT, args };
  }
  throw new RuntimeError('permission', `Command ${command} is not allowed in a work copy`);
}

function pathCommand(command: string, args: string[]): ResolvedCommand {
  const candidates = command.includes('/')
    ? [command]
    : (process.env.PATH ?? '').split(':').filter(Boolean).map(directory => `${directory}/${command}`);
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return { executable: candidate, args };
    } catch { /* keep looking */ }
  }
  throw new RuntimeError('permission', `Command ${command} was not found on PATH`);
}

function resolveHostCommand(command: string, args: string[]): ResolvedCommand {
  if (command === 'node') return resolveNodeCommand(args);
  return pathCommand(command, args);
}

/**
 * The command as the host itself would run it, for a check that declared `sandbox: false`.
 *
 * No allowlist and no sandbox shim: the whole point of the declaration is that the check runs the way
 * the project runs it, and a suite that starts a thousand processes was never going to survive a
 * seatbelt. The Node runtime is still the one that hosts Graph (a packaged app ships its own, and
 * under Electron the binary only runs Node when the environment says so) - that is about which binary
 * to launch, not about isolation.
 */
export function resolveUnsandboxedCommand(command: string, args: string[]): ResolvedCommand {
  if (command === 'node') return resolveNodeCommand(args, graphNodeRuntime(), { shim: false });
  return pathCommand(command, args);
}

/**
 * Build/test entry point for an Agent work copy.
 *
 * The command and its arguments stay inside the verified OS sandbox; the
 * process runs one restricted call through the same send gate as models.
 */
export async function openWorkspaceCommandRunner(input: {
  workspace: string;
  scratchDir: string;
  gate: RestrictedGate;
  readPaths?: string[];
  env?: Record<string, string>;
  localNetwork?: boolean;
  access?: ResolvedAccessPolicy;
  /** Let a host-mode command write Git metadata inside its own scratch directory only. */
  gitMetadataWritesInsideScratch?: boolean;
  /** How long the command may run. Defaults to two minutes. */
  timeoutMs?: number;
}) {
  const workspace = await realpath(input.workspace);
  let acquired: Awaited<ReturnType<typeof acquireRestrictedExecutor>> | undefined;
  let closed = false;
  return {
    async run(command: string, args: string[]): Promise<CommandResult> {
      const hostCommands = input.access?.commands === 'host';
      const resolved = hostCommands ? resolveHostCommand(command, args) : validateWorkspaceCommand(command, args);
      if (!acquired) acquired = await acquireRestrictedExecutor();
      await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
      const scratchDir = await realpath(input.scratchDir);
      const environment = { ...(input.env ?? {}), ...(resolved.env ?? {}) };
      return acquired.executor.run({
        broker: input.gate, cwd: workspace, scratchDir,
        executable: resolved.executable, args: resolved.args,
        readPaths: [workspace, dirname(resolved.executable), ...(resolved.readPaths ?? []), ...(input.readPaths ?? [])],
        writePaths: [workspace, scratchDir],
        ...(hostCommands ? {
          filesystem: 'host' as const,
          protectedPaths: input.access?.protectedPaths ?? [],
          allowUnrestrictedNetwork: input.access?.network === 'unrestricted',
          allowLocalBinding: input.access?.piExtensions.localBinding === true,
          allowAllUnixSockets: input.access?.piExtensions.unixSockets === 'all',
          allowAppleEvents: input.access?.piExtensions.appleEvents === true,
          allowGitMetadataWritesAll: input.access?.filesystem.gitMetadata === 'writable',
          ...(input.gitMetadataWritesInsideScratch ? { gitMetadataWritesInsideScratch: true } : {}),
        } : {}),
        timeoutMs: input.timeoutMs ?? 120_000,
        ...(Object.keys(environment).length ? { env: environment } : {}),
        ...(input.localNetwork ? { localNetwork: true } : {}),
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (acquired) await acquired.release();
    },
  };
}
