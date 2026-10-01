import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Socket } from 'node:net';
import type { AgentSessionInspect } from '../../src/runtime/agent-session.ts';

/**
 * Spike-1 host harness (Issue #1 §16). Spawns the RESIDENT worker as its own OS
 * process, sends control commands on stdin, and reads notifications off fd 3 —
 * the same split the future kernel host will use.
 *
 * Feasibility evidence lives in tests: this is not production plumbing.
 */

export interface ResidentHandle {
  processId: number;
  /** One turn over the resident session; resolves with the post-turn inspect. */
  turn(text: string): Promise<{ turnId: string; inspect: AgentSessionInspect & { processId: number } }>;
  inspect(): Promise<AgentSessionInspect & { processId: number }>;
  alive(): boolean;
  pidIsStable(): boolean;
  stop(): Promise<void>;
}

export async function spawnResident(options: {
  workerEntry: string;
  config: unknown;
  cwd: string;
}): Promise<ResidentHandle> {
  const configPath = join(options.cwd, 'resident-worker.json');
  await writeFile(configPath, JSON.stringify(options.config), { mode: 0o600 });
  const child = spawn(process.execPath, [options.workerEntry, configPath], {
    cwd: options.cwd,
    stdio: ['pipe', 'ignore', 'inherit', 'pipe'],
  }) as ChildProcess;
  const channel = child.stdio[3] as Socket;
  const stdin = child.stdin!;
  const originalPid = child.pid!;

  const pending = new Map<string, (value: Record<string, unknown>) => void>();
  let ready: (AgentSessionInspect & { processId: number }) | undefined;
  let closed = false;
  child.on('exit', () => { closed = true; });

  const buffer: string[] = [];
  channel.on('data', (chunk: Buffer) => {
    buffer.push(chunk.toString());
    let text = buffer.join('');
    let newline = text.indexOf('\n');
    while (newline >= 0) {
      const line = text.slice(0, newline);
      text = text.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line) as { operation?: string; requestId?: string; inspect?: AgentSessionInspect & { processId: number } };
        if (message.operation === 'ready' && message.inspect) readyInspect?.(message.inspect);
        const resolve = message.requestId ? pending.get(message.requestId) : undefined;
        if (resolve) { pending.delete(message.requestId!); resolve(message); }
      }
      newline = text.indexOf('\n');
    }
    buffer.length = 0;
    buffer.push(text);
  });
  let resolveReady: (inspect: AgentSessionInspect & { processId: number }) => void;
  const readyInspect = (inspect: AgentSessionInspect & { processId: number }) => { ready = inspect; resolveReady?.(inspect); };
  const readyPromise = new Promise<AgentSessionInspect & { processId: number }>(resolve => { resolveReady = resolve; });
  if (ready) resolveReady!(ready);
  const inspect0 = await readyPromise;

  const send = (message: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const requestId = String(Math.random());
    return new Promise(resolve => {
      pending.set(requestId, resolve);
      stdin.write(`${JSON.stringify({ ...message, requestId })}\n`);
    });
  };

  return {
    processId: inspect0.processId,
    alive: () => !closed && child.exitCode === null,
    pidIsStable: () => child.pid === originalPid && !closed,
    async turn(text) {
      const result = await send({ operation: 'start-turn', text });
      const turn = result.turn as { id: string; inspect: AgentSessionInspect & { processId: number } } | undefined;
      if (!turn) throw new Error(String(result.error ?? 'resident turn produced no result'));
      return { turnId: turn.id, inspect: turn.inspect };
    },
    async inspect() {
      const result = await send({ operation: 'inspect' });
      return result.inspect as AgentSessionInspect & { processId: number };
    },
    async stop() {
      if (closed) { channel.destroy(); return; }
      // The worker exits on `close`; resolve on exit, with a hard kill as the
      // fallback so a stuck worker can never hang a test or the cleanup hook.
      const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
      stdin.write(`${JSON.stringify({ operation: 'close' })}\n`);
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
      if (!closed && child.exitCode === null) { child.kill('SIGKILL'); await exited.catch(() => undefined); }
      channel.destroy();
    },
  };
}
