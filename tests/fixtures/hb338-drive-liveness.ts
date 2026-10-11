/**
 * HB-338 candidate, minimal and isolated: no Git, no project root, no external provider.
 *
 * A graph whose operation cannot be dispatched yet (a legal pre-send wait) stays runnable and keeps
 * proposing the same unprocessed input. `Execution.drive` awaits only work that is already settled,
 * so it yields to microtasks but never to the event loop: timers, HTTP and signal handlers starve.
 *
 * The child half of `tests/m8/execution-drive-liveness.test.ts`. It is a separate process because a
 * starved event loop also starves the timer a test would use to time out.
 *
 * Mode `resume`: the wait clears, the same delivery must be consumed exactly once.
 * Mode `stop`:   the wait never clears; drain must return and leave the delivery pending.
 * Arg 4 `main`:  also run a legitimate main node whose action waits 400 ms, so a real pending promise
 *                is outstanding while the graph keeps re-proposing its input.
 */
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { GraphRuntime } from '../../src/core/graph-runtime.ts';
import { GraphLane } from '../../src/core/graph-lane.ts';
import { Execution } from '../../src/core/execution.ts';
import type { ActionAdapter } from '../../src/core/types.ts';
import { RuntimeError } from '../../src/core/types.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const mode = process.argv[3] === 'stop' ? 'stop' : 'resume';
const withMain = process.argv[4] === 'main';
const store = new TaskStore(process.argv[2]!);
store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
const kernel = new KernelStore(store);
const graph = new GraphRuntime(kernel, 'g');
graph.create(parseGraphDefinition({ schemaVersion: 2, name: 'waiting check',
  protocols: { data: { type: 'object' } }, nodes: {},
  modules: { check: { type: 'operation', trigger: 'once', inputs: { job: { protocol: 'data' } },
    outputs: { result: { protocol: 'data' } },
    operation: { action: 'workspace.command', version: 1, command: 'node', args: [], output: 'result' } } },
  edges: {} }), { projectId: 'p' });
graph.deliverEndpoint('check.job', {});
if (withMain) {
  store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('main-task','p','waiting main',2,'discussing')").run();
  store.db.prepare("INSERT INTO nodes(task_id,id,spec,status,activation_id) VALUES('main-task','master',?,'pending','main-activation')").run(JSON.stringify({ kind: 'agent', role: 'master', action: 'hold' }));
  store.db.prepare("INSERT INTO instances(id,task_id,node_id) VALUES('main-instance','main-task','master')").run();
  store.db.prepare("UPDATE nodes SET instance_id='main-instance' WHERE task_id='main-task' AND id='master'").run();
  store.db.prepare("INSERT INTO activations VALUES('main-activation','main-task','master',1,1,'pending','{}')").run();
  store.db.prepare("UPDATE runtime SET active_task='main-task'").run();
}

let waiting = true;
let calls = 0;
let heartbeats = 0;
const heartbeat = setInterval(() => { heartbeats += 1; process.stdout.write(`HEARTBEAT ${heartbeats}\n`); }, 100);
const release = mode === 'resume' ? setTimeout(() => { waiting = false; }, 500) : undefined;
let drainWork: Promise<void> | undefined;
const stopping = setTimeout(() => { drainWork = execution.drain(); }, mode === 'stop' ? 300 : 2500);

const lane = new GraphLane({ kernel, config: () => ({}), host: async () => { throw new Error('no agent expected'); },
  operation: async () => {
    calls += 1;
    if (waiting) throw new RuntimeError('paused', 'Waiting before dispatch');
    return { ok: true, state: null, outputs: { result: { passed: true } }, diagnostics: [] };
  } });
const holdActions: Record<string, ActionAdapter> = { hold: { kind: 'agent', reserveTokens: 0, prepare: async () => async () => {
  process.stdout.write('MAIN_STARTED\n');
  await new Promise(resolve => setTimeout(resolve, 400));
  return { outcome: 'completed', output: { text: 'main done' }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
} } };
const execution = new Execution(store, withMain ? holdActions : {}, { graphs: () => lane.runnable() });

process.stdout.write('START\n');
const result = await execution.drive();
clearInterval(heartbeat);
if (release) clearTimeout(release);
clearTimeout(stopping);
// Never close the database over a main action that is still settling.
if (drainWork) await drainWork;
const delivery = store.db.prepare('SELECT d.id AS id,i.processed AS processed FROM kernel_deliveries d JOIN kernel_module_inbox i ON i.delivery_id=d.id LIMIT 1').get() as { id: string; processed: number };
const transition = store.db.prepare('SELECT outputs FROM kernel_module_transitions ORDER BY rowid DESC LIMIT 1').get() as { outputs: string } | undefined;
const pending = store.db.prepare('SELECT COUNT(*) AS n FROM kernel_module_inbox WHERE processed=0').get() as { n: number };
const paused = kernel.nodeState('g', 'check').paused;
process.stdout.write(`RETURNED ${JSON.stringify(result)}\n`);
process.stdout.write(`DELIVERY processed=${delivery.processed} transition=${transition?.outputs ?? 'none'}\n`);
process.stdout.write(`STATE inbox_pending=${pending.n} paused=${paused} calls=${calls} heartbeats=${heartbeats}\n`);
await lane.close();
store.close();
