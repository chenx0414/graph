import type { ProcessQuiescenceReceipt } from '../core/process-quiescence.ts';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { graphNodeRuntime } from './workspace-command.ts';

/**
 * Run one command as the host would run it: a direct process, no seatbelt.
 *
 * This exists for the one case where the sandbox makes the proof worthless. A confirmed gate that
 * runs a project's own suite has to run the way that suite is run by the project itself; measured
 * 2026-09-30 on task 68543fed, the same copy and the same `node --run check` gave 1480/1480 outside
 * the sandbox and 224 failed / 49 passed inside it, mostly the suite's own timeouts. A gate that
 * fails for reasons unrelated to the work is not evidence of anything.
 *
 * A supervisor starts the command in its own process group and kills it on timeout, cancellation
 * or owner IPC disconnect. The owner bounds the output it keeps. What it does NOT do is decide
 * anything - not whether it was allowed to run (that is `graph.command`'s `sandbox` declaration,
 * honoured only under full access) and not what the command may see (that is `checkEnvironment`).
 */

/** How much of one stream is kept: a check that prints more than this is flooding, not evidencing. */
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * The environment an unsandboxed check runs with.
 *
 * Leaving the sandbox lifts containment; it must not hand over the host's own environment. The first
 * version of this inherited `process.env`, which gave a check the app's provider credentials
 * (`GRAPH_SUBSCRIPTION_*`), the path of the live checkout, and a PATH without the toolchain - and
 * every process the check spawned - so the environment is now built from a short allowlist of what a
 * toolchain needs, plus whatever the host declared for checks. The allowlist is exactly the
 * difference between "runs like the project" and "runs with everything the app has".
 */
export function checkEnvironment(input: {
  executable: string;
  /** What the host declared for checks; it wins over the allowlist. */
  declared?: Record<string, string>;
  /** Read for a few names only - never inherited wholesale. */
  host?: Record<string, string | undefined>;
}): Record<string, string> {
  const host = input.host ?? {};
  // A GUI-launched app gets a minimal PATH (/usr/bin:/bin:/usr/sbin:/sbin) that a developer's shell
  // does not have: the toolchain a project's own suite drives - homebrew, /usr/local - lives outside
  // it. Naming those directories is the difference between "runs like the project" and "runs like the
  // app that started it"; measured 2026-09-30, the merge Agent had to prepend /opt/homebrew/bin by
  // hand to run the same suite.
  const path = [...new Set([
    dirname(input.executable),
    ...(host['PATH'] ?? '').split(':'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].filter(Boolean))].join(':');
  return {
    PATH: path,
    HOME: host['HOME'] ?? homedir(),
    ...(host['TMPDIR'] ? { TMPDIR: host['TMPDIR'] } : {}),
    LANG: host['LANG'] ?? 'en_US.UTF-8',
    ...(host['LC_ALL'] ? { LC_ALL: host['LC_ALL'] } : {}),
    GIT_OPTIONAL_LOCKS: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    ...(input.declared ?? {}),
  };
}

export interface HostCommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  outputFiles?: Record<'stdout' | 'stderr', { path: string; bytes: number; digest: string }>;
}

export interface HostCommandInput {
  /** Host-owned operation directory. Full streams survive bounded inline views. */
  outputDir?: string;
  cwd: string;
  executable: string;
  args: string[];
  /** The whole environment for the child. Build it with `checkEnvironment`. */
  env?: Record<string, string>;
  /** How long the command may run. No limit when omitted. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Durable dispatch admission, after the supervisor is ready and before the command starts. */
  beforeStart?: () => void;
  /** Written by the supervisor only after the command has closed. */
  quiescence?: ProcessQuiescenceReceipt;
}

export async function runHostCommand(input: HostCommandInput): Promise<HostCommandResult> {
  return new Promise<HostCommandResult>((resolve, reject) => {
    if (input.signal?.aborted) { resolve({ code: null, stdout: '', stderr: '' }); return; }
    const streams = input.outputDir ? (() => {
      mkdirSync(input.outputDir!, { recursive: true, mode: 0o700 });
      const opened: number[] = [];
      try {
        const open = (name: string) => {
          const path = join(input.outputDir!, `${name}.log`);
          const fd = openSync(path, 'wx', 0o600);
          opened.push(fd);
          return { path, fd, bytes: 0, hash: createHash('sha256') };
        };
        return { stdout: open('stdout'), stderr: open('stderr') };
      } catch (error) { for (const fd of opened) closeSync(fd); throw error; }
    })() : undefined;
    const runtime = graphNodeRuntime();
    const child = spawn(runtime.execPath, [fileURLToPath(new URL('./host-command-worker.mjs', import.meta.url))], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {},
    });
    let admissionError: unknown;
    let result: { code: number | null; error?: string } | undefined;
    child.on('message', message => {
      const value = message as { kind?: string; code?: unknown; error?: unknown };
      if (value.kind === 'ready') {
        if (input.signal?.aborted || timedOut) { killTree(); return; }
        try { input.beforeStart?.(); child.send({ kind: 'start' }, () => {}); }
        catch (error) { admissionError = error; killTree(); }
      }
      if (value.kind === 'result' && (value.code === null || typeof value.code === 'number')) {
        result = { code: value.code, ...(typeof value.error === 'string' ? { error: value.error } : {}) };
      }
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let outputError: unknown;
    const preserve = (name: 'stdout' | 'stderr', chunk: Buffer) => {
      const stream = streams?.[name];
      if (!stream || outputError) return;
      try {
        let offset = 0;
        while (offset < chunk.length) offset += writeSync(stream.fd, chunk, offset, chunk.length - offset);
        stream.hash.update(chunk);
        stream.bytes += chunk.length;
      } catch (error) { outputError = error; killTree(); }
    };

    const keep = (chunks: Buffer[], bytes: number, chunk: Buffer) => {
      if (bytes >= MAX_OUTPUT_BYTES) { truncated = true; return bytes; }
      const room = Math.min(chunk.length, MAX_OUTPUT_BYTES - bytes);
      chunks.push(room === chunk.length ? chunk : chunk.subarray(0, room));
      if (room < chunk.length) truncated = true;
      return bytes + room;
    };

    child.stdout?.on('data', (chunk: Buffer) => { preserve('stdout', chunk); stdoutBytes = keep(stdout, stdoutBytes, chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { preserve('stderr', chunk); stderrBytes = keep(stderr, stderrBytes, chunk); });

    // A check that times out must say so in the record: the same wording the sandboxed runner uses,
    // because the difference between "the command said no" and "the harness cut it" is the whole
    // reason a reader can trust the failure at all.
    const killTree = () => {
      if (child.connected) child.send({ kind: 'cancel' }, () => { /* disconnect also cancels */ });
    };
    const abort = () => killTree();
    if (input.signal?.aborted) abort();
    else input.signal?.addEventListener('abort', abort, { once: true });
    const timer = input.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; killTree(); }, input.timeoutMs);

    const finish = (code: number | null, extraStderr = '') => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener('abort', abort);
      if (streams) for (const stream of Object.values(streams)) closeSync(stream.fd);
      if (outputError) { reject(outputError); return; }
      const reason = timedOut ? `Process terminated by SIGKILL: it exceeded the ${input.timeoutMs}ms timeout\n` : '';
      const tail = truncated ? `Output truncated at ${MAX_OUTPUT_BYTES} bytes\n` : '';
      if (admissionError !== undefined) { reject(admissionError); return; }
      resolve({
        code: timedOut ? null : code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}${extraStderr}${reason}${tail}`,
        ...(streams ? { outputFiles: Object.fromEntries(Object.entries(streams).map(([name, stream]) =>
          [name, { path: stream.path, bytes: stream.bytes, digest: stream.hash.digest('hex') }])) as NonNullable<HostCommandResult['outputFiles']> } : {}),
      });
    };

    child.on('error', error => finish(null, `${(error as Error).message}\n`));
    child.on('close', () => finish(result?.code ?? null, result?.error ?? (result ? '' : 'Command supervisor exited without a result\n')));
    child.send({ kind: 'prepare', quiescence: input.quiescence, cwd: input.cwd, executable: input.executable, args: input.args, env: input.env ?? {} }, error => {
      if (error) finish(null, `${error.message}\n`);
    });
  });
}
