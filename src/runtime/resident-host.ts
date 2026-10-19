import { workerModelOptions, type WorkerModelOptions } from './worker-model-options.ts';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { Socket } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { AgentSessionInspect } from './agent-session.ts';
import type { RestrictedProcessControl } from './restricted-process.ts';
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
  /** What this turn cost, when the provider reported it (§9 metering). */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; accounted?: boolean } | undefined;
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
  /** Production transport supplies the resolved OS sandbox and owns its process tree. */
  launch?: (callbacks: { message(value: unknown): void; exit(error: Error): void }) => Promise<{
    control: RestrictedProcessControl; exited: Promise<void>;
  }>;
  /**
   * Answers a node's tool call (HB-262). A tool like `submit` must run in the host, where
   * the kernel and the execution identity live, so the node's call arrives here and this
   * returns the result the node sees. Returning `ok:false` is how a refusal reaches the
   * model as a correctable error rather than an exception (§5).
   */
  onModelCall?: (context: unknown, signal: AbortSignal, options: WorkerModelOptions) => Promise<unknown>;
  onEvent?: (event: unknown) => void;
  onReady?: (inspect: ResidentInspect) => void;
  onToolCall?: (name: string, args: unknown) => { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }>;
}

const defaultWorkerEntry = fileURLToPath(new URL('./resident-worker-entry.ts', import.meta.url));

/** One resident worker process for one node, addressable across turns. */
export class ResidentHost {
  private child: ChildProcess | undefined;
  private restricted: { control: RestrictedProcessControl; exited: Promise<void> } | undefined;
  private startupReject: ((error: Error) => void) | undefined;
  private channel: Socket | undefined;
  private stdin: NodeJS.WritableStream | undefined;
  private originalPid: number | undefined;
  private readonly pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private ready: ResidentInspect | undefined;
  private closed = false;
  private disposed = false;
  private buffer = '';
  /** How many times this host started the underlying process (1 + recoveries + rebinds). */
  private spawns = 0;
  private modelAborts = new Set<AbortController>();
  private modelCalls = new Set<Promise<void>>();
  private readyResolvers: ((inspect: ResidentInspect) => void)[] = [];

  private readonly options: ResidentHostOptions;

  constructor(options: ResidentHostOptions) {
    this.options = options;
  }

  /** Start (or restart) the process. Idempotent while the process is alive. */
  async start(): Promise<ResidentInspect> {
    if (this.disposed) throw new Error('resident host was disposed');
    if (this.alive()) return this.awaitReady();
    await writeFile(this.options.configPath, JSON.stringify(this.options.config), { mode: 0o600 });
    if (this.disposed) throw new Error('resident host was disposed');
    this.closed = false; this.buffer = ''; this.ready = undefined;
    if (this.options.launch) {
      this.spawns += 1;
      const launched = await this.options.launch({
        message: value => this.onData(`${JSON.stringify(value)}\n`),
        exit: error => this.onExit(error),
      });
      if (this.disposed) { launched.control.kill('SIGKILL'); await launched.exited; throw new Error('resident host was disposed'); }
      this.restricted = launched;
      this.originalPid = launched.control.pid;
      const ready = await this.awaitReady();
      this.options.onReady?.(ready);
      return ready;
    }
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
    child.on('error', error => {
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
      this.closed = true;
    });
    child.on('exit', (code, signal) => {
      this.closed = true; this.buffer = '';
      for (const abort of this.modelAborts) abort.abort();
      this.modelAborts.clear();
      const error = new Error(`resident worker exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
    const ready = await this.awaitReady();
    this.ready = ready;
    this.options.onReady?.(ready);
    return ready;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf('\n');
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.trim()) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch {
          const error = new Error('Resident worker emitted invalid channel JSON');
          for (const request of this.pending.values()) request.reject(error);
          this.onExit(error); this.restricted?.control.kill('SIGKILL'); this.child?.kill('SIGKILL'); return;
        }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          this.onExit(new Error('Resident worker emitted invalid channel message'));
          this.restricted?.control.kill('SIGKILL'); this.child?.kill('SIGKILL'); return;
        }
        const message = parsed as { operation?: string; requestId?: string; inspect?: ResidentInspect; name?: string; args?: unknown; event?: unknown; context?: unknown; options?: unknown };
        // A node asking the host to run a tool (HB-262). The answer goes back on stdin,
        // the reverse direction of this channel, so the node's call resolves with it.
        if (message.operation === 'model_call' && message.requestId) {
          const requestId = message.requestId;
          const abort = new AbortController();
          this.modelAborts.add(abort);
          const call = Promise.resolve(this.options.onModelCall?.(message.context, abort.signal, workerModelOptions(message.options)) ?? Promise.reject(new Error('Host model transport unavailable')))
            .then(value => { if (!this.closed && !this.disposed) this.write(`${JSON.stringify({ operation: 'model_result', requestId, ok: true, value })}\n`); })
            .catch(error => { if (!this.closed && !this.disposed) this.write(`${JSON.stringify({ operation: 'model_result', requestId, ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); })
            .finally(() => { this.modelAborts.delete(abort); this.modelCalls.delete(call); });
          this.modelCalls.add(call);
          newline = this.buffer.indexOf('\n');
          continue;
        }
        if (message.operation === 'tool_call' && message.requestId) {
          const requestId = message.requestId;
          void Promise.resolve(this.options.onToolCall
            ? this.options.onToolCall(String(message.name), message.args)
            : { ok: false, text: `the host does not offer a tool named ${String(message.name)}` })
            .then(answer => { this.write(`${JSON.stringify({ operation: 'tool_result', requestId, ...answer })}\n`); })
            .catch(error => { this.write(`${JSON.stringify({ operation: 'tool_result', requestId, ok: false, text: error instanceof Error ? error.message : String(error) })}\n`); });
          newline = this.buffer.indexOf('\n');
          continue;
        }
        if (message.operation === 'event') this.options.onEvent?.(message.event);
        if (message.operation === 'ready' && message.inspect) this.resolveReady(message.inspect);
        const resolve = message.requestId ? this.pending.get(message.requestId) : undefined;
        if (resolve) { this.pending.delete(message.requestId!); resolve.resolve(message); }
      }
      newline = this.buffer.indexOf('\n');
    }
  }

  private write(line: string): void {
    if (this.restricted) this.restricted.control.write(JSON.parse(line));
    else this.stdin?.write(line);
  }

  private onExit(error: Error): void {
    this.closed = true; this.buffer = '';
    for (const abort of this.modelAborts) abort.abort();
    this.modelAborts.clear();
    this.startupReject?.(error); this.startupReject = undefined;
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
  }

  private resolveReady(inspect: ResidentInspect): void { this.ready = inspect; for (const resolve of this.readyResolvers.splice(0)) resolve(inspect); }
  private awaitReady(): Promise<ResidentInspect> {
    // A `ready` notification and this promise can race, so the resolver list is
    // checked by resolveReady whenever the worker announces itself; the timeout
    // only guards a worker that never does.
    if (this.closed) return Promise.reject(new Error('resident worker exited before ready'));
    if (this.ready) return Promise.resolve(this.ready);
    return new Promise<ResidentInspect>((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => { if (settled) return; settled = true; clearTimeout(timer); this.startupReject = undefined; action(); };
      const timer = setTimeout(() => finish(() => reject(new Error('resident worker did not become ready'))), 20_000);
      this.startupReject = error => finish(() => reject(error));
      this.readyResolvers.push(inspect => finish(() => resolve(inspect)));
      // A worker that dies before it is ready must fail now, not after the timeout: a
      // misconfigured node would otherwise hang the graph and hide the startup error.
      this.child?.once('error', error => finish(() => reject(error)));
      this.child?.once('exit', (code, signal) => finish(() => reject(new Error(`resident worker exited before ready (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''})`))));
    });
  }

  private send(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.stdin && !this.restricted) return Promise.reject(new Error('resident worker has no channel'));
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      this.write(`${JSON.stringify({ ...message, requestId })}\n`);
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
    return !this.closed && (this.restricted !== undefined || (this.child !== undefined && this.child.exitCode === null));
  }

  /** The same OS process is still running as when it started. */
  pidIsStable(): boolean {
    return this.alive() && this.pid() === this.originalPid;
  }

  pid(): number | null {
    return this.restricted?.control.pid ?? this.child?.pid ?? null;
  }

  /** How many processes this host has started for the node (1 + recoveries + rebinds). */
  spawnCount(): number {
    return this.spawns;
  }

  /** End the service lifecycle; an in-flight startup may not resurrect it. */
  async dispose(): Promise<void> { this.disposed = true; await this.stop(); }

  /** Stop the process. A later start() rebuilds it with the same identity. */
  async stop(): Promise<void> {
    for (const abort of this.modelAborts) abort.abort();
    if (this.restricted) {
      const process = this.restricted;
      if (this.alive()) {
        process.control.write({ operation: 'close' });
        await Promise.race([process.exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
        if (!this.closed) process.control.kill('SIGKILL');
      }
      await process.exited;
      await Promise.allSettled([...this.modelCalls]);
      this.restricted = undefined; this.closed = true;
      return;
    }
    const child = this.child;
    if (!child) { await Promise.allSettled([...this.modelCalls]); return; }
    if (this.alive()) {
      const exited = new Promise<void>(resolve => child.on('exit', () => resolve()));
      this.write(`${JSON.stringify({ operation: 'close' })}\n`);
      await Promise.race([exited, new Promise<void>(resolve => setTimeout(resolve, 2_000))]);
      if (this.child!.exitCode === null) child.kill('SIGKILL');
      await exited.catch(() => undefined);
    }
    // The worker can exit before the host finishes accounting for its HTTP send.
    // Keep SQLite open until every host-owned model callback has settled.
    await Promise.allSettled([...this.modelCalls]);
    this.channel?.destroy();
    this.child = undefined;
    this.channel = undefined;
    this.stdin = undefined;
    this.closed = true;
  }
}
