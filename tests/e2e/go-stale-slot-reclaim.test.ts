import { execFile, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A slot lock nobody is working behind, and a program slot nobody is running.
 *
 * `/tmp/graph-check-<uid>/slot.lock` is an flock, and an flock cannot say who
 * holds it: an empty file looks the same held and idle. When the runner that
 * took it is killed, its child keeps the inherited descriptor, and every other
 * worktree waits behind a check that will never finish - the queue reports
 * "Another worktree is checking" for ever and the only repair anybody knows is
 * `rm slot.lock` by hand.
 *
 * So the holder writes down who it is and when it last did something, and this
 * file builds that state for real: a live process holds the slot while the
 * record it wrote points at an owner that is dead, or at a heartbeat and work
 * directory that stopped moving. A real `scripts/check-queue.py` then has to
 * name the evidence, take the slot, and run the command it was given.
 *
 * The daemon has the same defect one level up: a program operation holds one of
 * four slots, and the row that grants it is only cleared by the process that took
 * it. The last case kills a real daemon while its operation is running and asks
 * a restarted daemon, on the same state directory, what happened to the slot.
 *
 * The queue directory is this test's own (GRAPH_CHECK_QUEUE_DIR): judging a lock
 * by killing what holds it is not something to rehearse on the slot every
 * worktree on this machine shares.
 */

const run = promisify(execFile);
const DATA = { protocol: 'data' };
const PROTOCOLS = { data: { type: 'object' } };

/** The holder: takes the slot for real, then writes the record the case asked for. */
const HOLDER = `
import fcntl, json, os, subprocess, sys, time

lock_path, owner_pid, owner_start, idle_dir = sys.argv[1:5]


def start(pid):
    try:
        result = subprocess.run(["ps", "-p", str(pid), "-o", "lstart="], capture_output=True, text=True)
    except OSError:
        return ""
    return result.stdout.strip()


lock = open(lock_path, "a+")
fcntl.flock(lock, fcntl.LOCK_EX)
held = os.getpid()
record = {
    "pid": held if owner_pid == "self" else int(owner_pid),
    "start": start(held) if owner_pid == "self" else owner_start,
    "childPid": held,
    "childStart": start(held),
    "cwd": idle_dir,
    # Hours old: the holder stopped reporting, and its work directory agrees.
    "heartbeatAt": time.time() - 3600,
    "runId": "stale-holder",
}
lock.seek(0)
lock.write(json.dumps(record))
lock.truncate()
lock.flush()
print("holding", flush=True)
while True:
    time.sleep(1)
`;

interface Holder { child: ReturnType<typeof spawn>; pid: number }

/** Starts a process that really holds the queue slot, and returns once it does. */
async function holdSlot(lockPath: string, owner: { pid: string; start: string }, idleDir: string): Promise<Holder> {
  const child = spawn('python3', ['-c', HOLDER, lockPath, owner.pid, owner.start, idleDir], {
    stdio: ['ignore', 'pipe', 'pipe'], detached: true,
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the holder never took the slot')), 20_000);
    child.stdout!.setEncoding('utf8');
    child.stdout!.on('data', (chunk: string) => {
      if (chunk.includes('holding')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
  });
  return { child, pid: child.pid! };
}

/** Waits until a process the queue asked to leave has really gone. */
async function exited(holder: Holder): Promise<boolean> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (holder.child.exitCode !== null || holder.child.signalCode !== null) return true;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

/** A pid that belonged to a process which has certainly exited. */
async function deadPid(): Promise<number> {
  const gone = spawn('python3', ['-c', 'pass'], { stdio: 'ignore' });
  await new Promise<void>(resolve => gone.once('exit', () => resolve()));
  return gone.pid!;
}

/** A queue directory of this case's own, with a work directory that stopped moving. */
async function queueRoot(): Promise<{ root: string; queue: string; idle: string }> {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-slot-'));
  const queue = join(root, 'queue');
  const idle = join(root, 'idle');
  await mkdir(queue, { recursive: true });
  await mkdir(idle, { recursive: true });
  const hours = new Date(Date.now() - 3_600_000);
  await utimes(idle, hours, hours);
  return { root, queue, idle };
}

/** A Git repository of its own, so the queue's worktree protection has something to hold. */
async function repository(root: string): Promise<string> {
  const tree = join(root, 'repository');
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, 'README.md'), 'repository\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: tree });
  }
  return tree;
}

/**
 * Runs one real check through the queue, and reports what it said.
 *
 * The command is the work a queued check does; the proof is the file it wrote,
 * so "the queue ran my command" is a fact about the filesystem and not about an
 * exit status.
 */
async function queuedCheck(scratch: string, queue: string) {
  const environment = { ...process.env, GRAPH_CHECK_QUEUE_DIR: queue };
  try {
    const done = await run('python3', [join(process.cwd(), 'scripts', 'check-queue.py'), '--', '/bin/sh', '-c', 'printf ran > proof.txt'], {
      cwd: scratch, env: environment, timeout: 60_000,
    });
    return { code: 0, stdout: done.stdout, stderr: done.stderr };
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: failed.code ?? -1, stdout: failed.stdout ?? '', stderr: failed.stderr ?? failed.message ?? '' };
  }
}

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
interface Step { id: string; name: string; args: unknown }

/** One scripted model: it answers with the next call of its plan and remembers the results. */
async function model(plan: (body: ChatBody) => Step | undefined, onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const say = (delta: unknown, finish: string | null) => response.write(frame({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const next = (body.tools ?? []).length ? plan(body) : undefined;
    if (!next || spoken.has(next.id)) {
      say({ role: 'assistant', content: 'Noted.' }, 'stop');
    } else {
      say({ role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
        function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, null);
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: {} }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    results,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Rows one graph really has in its own state database. */
function rows<T>(root: string, query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    return db.prepare(query).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

/** Drops the quiescence receipt of one operation, as the sandbox path never writes one. */
function clearReceipt(root: string, operationId: string) {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  try {
    db.prepare('UPDATE kernel_module_operations SET resource_receipt=NULL WHERE id=?').run(operationId);
  } finally {
    db.close();
  }
}

/** Polls a fact the product settles on its own, naming what it saw when it never settles. */
async function waitFor(read: () => string, timeout: number) {
  const deadline = Date.now() + timeout;
  let seen = '';
  while (Date.now() < deadline) {
    seen = read();
    if (seen === '') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`never settled: ${seen}`);
}

/** A Git project with the script the module runs. */
async function project(root: string): Promise<string> {
  const tree = join(root, 'project');
  await mkdir(join(tree, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(tree, 'README.md'), 'project\n');
  // The command outlives the daemon, so the operation is really running when the
  // process that dispatched it disappears.
  await writeFile(join(tree, 'test', 'hang.js'), 'setTimeout(() => {}, 20000);\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md', 'test/hang.js'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: tree });
  }
  return tree;
}

/** A real daemon driving a real model, on the state directory the case names. */
async function daemonFor(root: string, tree: string, master: { baseUrl: string }) {
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: tree }],
    credentials: { lease: { secretRef: 'GRAPH_LEASE_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
      baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'lease' }] },
  }));
  return launchCli(root, { configPath, env: { GRAPH_LEASE_KEY: 'lease-synthetic' }, extraArgs: ['--execute'] });
}

test('a slot held by a dead owner is reclaimed, and the queued check runs', async () => {
  const { root, queue, idle } = await queueRoot();
  const scratch = await repository(root);
  const owner = await deadPid();
  let holder: Holder | undefined;
  try {
    holder = await holdSlot(join(queue, 'slot.lock'), { pid: String(owner), start: 'Mon Jan  1 00:00:00 2001' }, idle);
    const check = await queuedCheck(scratch, queue);

    // The queue named the evidence it judged on, before it took the slot.
    expect(check.stdout).toContain(`[check queue] Reclaimed stale slot held by pid ${owner} (owner_gone)`);
    expect(check.stdout).toContain('[check queue] Running in');
    // And the queued command really ran: the proof is a file, not an exit code.
    expect(check.code).toBe(0);
    expect(await readFile(join(scratch, 'proof.txt'), 'utf8')).toBe('ran');
    // The process holding the inherited descriptor is gone.
    expect(await exited(holder)).toBe(true);
  } finally {
    holder?.child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('a slot whose heartbeat and work directory both stopped is reclaimed', async () => {
  const { root, queue, idle } = await queueRoot();
  const scratch = await repository(root);
  let holder: Holder | undefined;
  try {
    // The owner is alive and still the process that recorded the slot, so the pid
    // says nothing. What is stale is the progress: no heartbeat for an hour and a
    // work directory that has not been written to in the same hour.
    holder = await holdSlot(join(queue, 'slot.lock'), { pid: 'self', start: '' }, idle);
    const before = await stat(join(idle));
    const check = await queuedCheck(scratch, queue);

    expect(check.stdout).toContain(`[check queue] Reclaimed stale slot held by pid ${holder.pid} (heartbeat_stalled)`);
    expect(check.code).toBe(0);
    expect(await readFile(join(scratch, 'proof.txt'), 'utf8')).toBe('ran');
    // The judgment was about progress, not about this case touching the directory.
    expect((await stat(join(idle))).mtimeMs).toBe(before.mtimeMs);
    expect(await exited(holder)).toBe(true);
  } finally {
    holder?.child.kill('SIGKILL');
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);

test('a program slot held by a daemon that is gone is released on the next start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-lease-'));
  const tree = await project(root);
  const graphs: string[] = [];
  const graphIdOf = () => graphs[0] ?? '';
  const definition = {
    schemaVersion: 2,
    name: 'Leased program slot',
    protocols: PROTOCOLS,
    nodes: {},
    modules: {
      check: {
        type: 'operation', trigger: 'each', inputs: { job: DATA }, outputs: { result: DATA },
        operation: { action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result', args: ['test/hang.js'] },
      },
    },
    edges: {}, inputs: {}, outputs: { result: { from: 'check.result', protocol: 'data' } },
  };
  const leases = () => rows<{ id: string; state: string; worker_active: number }>(root,
    'SELECT id,state,worker_active FROM kernel_module_operations WHERE task_id=?', graphIdOf());
  const released = () => rows<{ data: string }>(root,
    "SELECT data FROM events WHERE task_id=? AND type='graph.operation.resources_released'", graphIdOf())
    .map(row => JSON.parse(row.data));

  const master = await model(() => (
    graphs[0] ? { id: 'send', name: 'graph_send', args: { graphId: graphs[0], nodeId: 'check', input: 'job', value: { marker: 'go' } } }
      : { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } }
  ), (id, content) => {
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (id === 'create' && found) graphs[0] = found[1]!;
  });

  const first = await daemonFor(root, tree, master);
  let second: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const started = await first.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the hanging check.', requestId: 'lease-begin' }),
    });
    expect(started.status).toBe(200);

    // The operation crossed its send boundary and holds a program slot, and the
    // command outlives the daemon so nothing settles it in the meantime.
    await waitFor(() => {
      const current = leases();
      return current.length === 1 && current[0]!.state === 'dispatched' && current[0]!.worker_active === 1
        ? '' : `leases=${JSON.stringify(current)}`;
    }, 120_000);
    const operation = leases()[0]!;

    // The daemon really dies while that operation runs: nothing gives the slot back.
    first.child.kill('SIGKILL');
    await new Promise<void>(resolve => first.child.once('exit', () => resolve()));
    expect(leases()).toEqual([{ id: operation.id, state: 'dispatched', worker_active: 1 }]);
    // A sandboxed operation records no quiescence receipt - the sandbox path never
    // writes one - so its lease cannot be released by verifying that the command
    // closed. That is the shape the rest of this case needs, and sandbox-exec does
    // not run inside this environment, so the receipt is dropped here instead.
    clearReceipt(root, operation.id);

    // A new daemon on the same state directory owns the graph now, and the slot
    // the dead one held is not capacity: it is released, with the judgment this
    // start could make - the process that recorded it is gone.
    second = await daemonFor(root, tree, master);
    await waitFor(() => {
      const current = leases();
      return current.length === 1 && current[0]!.worker_active === 0 && released().length > 0
        ? '' : `leases=${JSON.stringify(current)} released=${JSON.stringify(released())}`;
    }, 120_000);
    expect(leases()).toEqual([{ id: operation.id, state: 'uncertain', worker_active: 0 }]);
    // The judgment is named: this start holds the owner lock, so the process that
    // recorded the lease is gone.
    expect(released()).toEqual([{ operationId: operation.id, source: 'recovery', reason: 'owner_restart' }]);
    // No program slot is held any more, so the queue behind it is not starving on
    // a lease nothing can give back.
    expect(rows<{ n: number }>(root, 'SELECT COUNT(*) AS n FROM kernel_module_operations WHERE worker_active=1')).toEqual([{ n: 0 }]);
  } finally {
    await first.close().catch(() => undefined);
    await second?.close().catch(() => undefined);
    await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
