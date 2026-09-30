import { spawn } from 'node:child_process';

/**
 * Run one command as the host would run it: a direct process, the host environment, no sandbox.
 *
 * This exists for the one case where the sandbox makes the proof worthless. A confirmed gate that
 * runs a project's own suite has to run the way that suite is run by the project itself; measured
 * 2026-09-30 on task 68543fed, the same copy and the same `node --run check` gave 1480/1480 outside
 * the sandbox and 224 failed / 49 passed inside it, mostly the suite's own timeouts. A gate that
 * fails for reasons unrelated to the work is not evidence of anything.
 *
 * It is deliberately the plainest possible runner. It inherits `process.env`, because the toolchain
 * the check drives expects the host's PATH, HOME and credentials; it keeps the host's own temporary
 * directory; it starts the child in its own process group so a timeout can kill the whole tree. What
 * it does NOT do is decide whether it was allowed to run: which checks may use it is the caller's
 * rule (`graph.command`'s `sandbox` declaration, honoured only under full access), and this file
 * only runs what it is handed.
 */

/** How much of one stream is kept: a check that prints more than this is flooding, not evidencing. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

export interface HostCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface HostCommandInput {
  cwd: string;
  executable: string;
  args: string[];
  /** Extra environment on top of the host's, not instead of it. */
  env?: Record<string, string>;
  /** How long the command may run. No limit when omitted. */
  timeoutMs?: number;
}

export async function runHostCommand(input: HostCommandInput): Promise<HostCommandResult> {
  return new Promise<HostCommandResult>(resolve => {
    const child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(input.env ?? {}) },
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;

    const keep = (chunks: Buffer[], bytes: number, chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return bytes; }
      const room = Math.min(chunk.length, MAX_OUTPUT_BYTES - bytes);
      chunks.push(room === chunk.length ? chunk : chunk.subarray(0, room));
      if (room < chunk.length) truncated = true;
      return bytes + room;
    };

    child.stdout?.on('data', (chunk: Buffer) => { stdoutBytes = keep(stdout, stdoutBytes, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { stderrBytes = keep(stderr, stderrBytes, chunk); });

    // A check that times out must say so in the record: the same wording the sandboxed runner uses,
    // because the difference between "the command said no" and "the harness cut it" is the whole
    // reason a reader can trust the failure at all.
    const killTree = () => {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* already gone */ } }
    };
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);

    const finish = (code: number | null, extraStderr = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const reason = timedOut ? `Process terminated by SIGKILL: it exceeded the ${input.timeoutMs}ms timeout\n` : '';
      const tail = truncated ? `Output truncated at ${MAX_OUTPUT_BYTES} bytes\n` : '';
      resolve({
        code: timedOut ? null : code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}${extraStderr}${reason}${tail}`,
      });
    };

    child.on('error', error => finish(null, `${(error as Error).message}\n`));
    child.on('close', code => finish(code));
  });
}
