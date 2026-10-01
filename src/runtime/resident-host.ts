import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AgentSessionInspect } from './agent-session.ts';
import type { PiWorkerConfig } from './pi-process.ts';

/**
 * The kernel's resident-process manager (Issue #1 §7, §13.3).
 *
 * One long-lived Pi worker process per node. The host spawns it, drives turns over
 * an stdin/fd-3 channel, and — when the process crashes — rebuilds it while the
 * node's identity, session lineage, queue, budget and submissions stay unchanged.
 *
 * This is the production form of the Phase-1 spike harness (`tests/fixtures/
 * resident-host.ts`): the spike proved residency and rebind; this module is what
 * the kernel actually runs.
 */

export interface ResidentInspect extends AgentSessionInspect {
  processId: number;
}

export interface ResidentTurnResult {
  turnId: string;
  inspect: ResidentInspect;
}

export interface ResidentHostOptions {
  /** The worker entry script; defaults to the production resident worker entry. */
  workerEntry: string;
  /** The serialized session config the worker process reads. */
  config: PiWorkerConfig;
  /** Working directory the process runs in. */
  cwd: string;
  /** Where the config file is written (must be inside a granted write root). */
  configPath: string;
  /** Optional node runtime spawner; the default uses node's child_process. */
  spawnImpl?: typeof spawn;
}

const defaultWorkerEntry = fileURLToPath(new URL('./resident-worker-entry.ts', import.meta.url));

/** One resident worker process for one node, addressable across turns. */
export class ResidentHost {
  private child: ChildProcess | undefined;
  private channel: Socket | undefined;
  private stdin: NodeJS.WritableStream | undefined;
  private originalPid: number | undefined;
  private readonly pending = new Map<string, (value: Record<string, unknown>) => void>();
  private ready: ResidentInspect | undefined;
  private closed = false;
  private buffer = '';
  /** How many times this host started the underlying process (1 + recoveries + rebinds). */
  private spawns = 0;
  private readyResolvers: ((inspect: ResidentInspect) => void)[] = [];

  constructor(private readonly options: ResidentHostOptions) {}

  /** Start (or restart) the process. Idempotent while the process is alive. */
  async start(): Promise<ResidentInspect> {
    if (this.child && this.alive()) return this.ready!;
    await writeFile(this.options.configPath, JSON.stringify(this.options.config), { mode: 0o600 });
    const spawnImpl = this.options.spawnImpl ?? spawn;
    const entry = this.options.workerEntry || defaultWorkerEntry;
    const child = spawnImpl(process.execPath, [entry, this.options.configPath], {
      cwd: this.options.cwd,
      stdio: ['pipe', 'ignore', 'inherit', 'pipe'],
    }) as ChildProcess;
    this.child = child;
    this.channel = child.stdio[3] as Socket;
    this.stdin = child.stdin!;
    this.originalPid = child.pid;
    this.closed = false;
    this.spawns += 1;
    this.buffer = '';
    this.ready = undefined;
    this.channel.on('data', (chunk: Buffer) => this.onData(chunk.toString()));
    child.on('exit', () => { this.closed = true; this.buffer = ''; });
    const ready = await this.awaitReady();
    this.ready = ready;
    return ready;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        const message = JSON.parse(line) as { operation?: string; requestId?: string; inspect?: ResidentInspect };
        if (message.operation === 'ready' && message.inspect) this.resolveReady(message.inspect);
        const resolve = message.requestId ? this.pending.get(message.requestId) : undefined;
        if (resolve) { this.pending.delete(message.requestId!); resolve(message); }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private resolveReady(inspect: ResidentInspect): void { for (const resolve of this.readyResolvers.splice(0)) resolve(inspect); }
  private awaitReady(): Promise<ResidentInspect> {
    // A `ready` notification and this promise can race, so the resolver list is
    // checked by resolveReady whenever the worker announces itself; the timeout
    // only guards a worker that never does.
    return new Promise<ResidentInspect>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('resident worker did not become ready')); } }, 20_000);
      this.readyResolvers.push(inspect => { if (settled) return; settled = true; clearTimeout(timer); resolve(inspect); });
    });
  }

  private send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.stdin) return Promise.reject(new Error('resident worker has no channel'));
    const requestId = String(this.pending.size) + ':' + Date.now().toString(36);
    return new Promise(resolve => {
      this.pending.set(requestId, resolve);
      this.stdin!.write(`${JSON.stringify({ ...message, requestId })}\n`);
    });
  }

  /** Run one turn over the resident session; the process survives the turn. */
  async turn(text: string): Promise<ResidentTurnResult> {
    if (!this.alive()) throw new Error('resident worker is not running');
    const result = await this.send({ operation: 'start-turn', text });
    const turn = result.turn as ResidentTurnResult | undefined;
    if (!turn) throw new Error(String(result.error ?? 'resident turn produced no result'));
    return turn;
  }

  async inspect(): Promise<ResidentInspect> {
    if (!this.alive()) throw new Error('resident worker is not running');
    const result = await this.send({ operation: 'inspect' });
    return result.inspect as ResidentInspect;
  }

  alive(): boolean {
    return this.child !== undefined && !this.closed && this.child.exitCode === null;
  }

  /** The same OS process is still running as when it started. */
  pidIsStable(): boolean {
    return this.alive() && this.child!.pid === this.originalPid;
  }

  pid(): number | null {
    return this.child?.pid ?? null;
  }

  /** How many processes this host has started for the node (1 + recoveries + rebinds). */
  spawnCount(): number {
    return this.spawns;
  }

  /** Stop the process. A later start() rebuilds it with the same identity. */
  async stop(): Promise<void> {
    const child = this.child;
    if (!child) return;
    if (this.alive()) {
      const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
      this.stdin?.write(`${JSON.stringify({ operation: 'close' })}\n`);
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
      if (this.child!.exitCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
    this.channel?.destroy();
    this.child = undefined;
    this.channel = undefined;
    this.stdin = undefined;
    this.closed = true;
  }
}
