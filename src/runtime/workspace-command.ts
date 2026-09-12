import { mkdir, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { RuntimeError } from '../core/types.ts';
import { acquireRestrictedExecutor, type RestrictedGate } from './restricted-process.ts';

const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show']);
const INLINE_NODE = new Set(['-e', '--eval', '-p', '--print', '--input-type']);

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** A conservative allowlist: build/test commands plus read-only Git. */
export function validateWorkspaceCommand(command: string, args: string[]) {
  if (command === 'node') {
    if (args.some(arg => INLINE_NODE.has(arg) || arg.startsWith('--eval='))) {
      throw new RuntimeError('permission', 'Inline node evaluation is not allowed in a work copy');
    }
    return { executable: process.execPath, args };
  }
  if (command === 'git') {
    if (!READ_ONLY_GIT.has(args[0] ?? '')) throw new RuntimeError('permission', 'Only read-only Git commands are allowed');
    return { executable: '/usr/bin/git', args };
  }
  throw new RuntimeError('permission', `Command ${command} is not allowed in a work copy`);
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
}) {
  const workspace = await realpath(input.workspace);
  let acquired: Awaited<ReturnType<typeof acquireRestrictedExecutor>> | undefined;
  let closed = false;
  return {
    async run(command: string, args: string[]): Promise<CommandResult> {
      const resolved = validateWorkspaceCommand(command, args);
      if (!acquired) acquired = await acquireRestrictedExecutor();
      await mkdir(input.scratchDir, { recursive: true, mode: 0o700 });
      const scratchDir = await realpath(input.scratchDir);
      return acquired.executor.run({
        broker: input.gate, cwd: workspace, scratchDir,
        executable: resolved.executable, args: resolved.args,
        readPaths: [workspace, dirname(resolved.executable)],
        writePaths: [workspace, scratchDir],
        timeoutMs: 120_000,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      if (acquired) await acquired.release();
    },
  };
}
