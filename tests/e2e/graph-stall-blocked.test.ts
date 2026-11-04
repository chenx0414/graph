import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

import {
  FAILING_DEFINITION, answeredGraphId, graphIdOf, masterProvider, waitForStep, type MasterCall,
} from './acceptance-limitations.fixture.ts';

/**
 * A graph that cannot move parks itself.
 *
 * Measured 2026-11-04 on two real graphs: their nodes had all settled (one
 * blocked, one failed, the rest succeeded), nothing was queued and nothing was
 * running, and the graph still said "running" forever. The only door out of a
 * graph - a closure that records limitations - refuses anything that is not
 * blocked, so those graphs could never be closed at all: not because evidence
 * was missing, but because the phase never moved.
 *
 * This is the proof: a graph whose only node really fails reaches "blocked"
 * without anybody asking it to complete, and work that arrives later un-parks
 * it again. No completion request, no control call: only a failing check and
 * the daemon's own bookkeeping.
 */
test('a graph with no work left and a failed node reaches blocked by itself, and sent work makes it running again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-stall-blocked-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'test', 'fails.js'), 'console.error("check failed");\nprocess.exit(1);\n');

  let plan: () => MasterCall[] = () => [];
  const master = await masterProvider(() => plan());
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const operationCount = (graphId: string) => {
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      return (db.prepare('SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=?').get(graphId) as { n: number }).n;
    } finally {
      db.close();
    }
  };
  // The run really ended, so the phase read next belongs to the settled graph
  // and not to the one that parked before this work arrived.
  const settledOperationCount = (graphId: string) => {
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      return (db.prepare("SELECT COUNT(*) AS n FROM kernel_module_operations WHERE task_id=? AND state='settled'").get(graphId) as { n: number }).n;
    } finally {
      db.close();
    }
  };
  // Work handed to a paused target can never run - a queue item on a paused node
  // is never claimed, and a delivery to a paused module waits in
  // kernel_module_inbox - and that is the shape graph 50fa0860 was stuck in:
  // four "queued" rows on three paused nodes. That is not live work.
  const pendingWorkForPaused = (graphId: string) => {
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      const queued = db.prepare(`SELECT COUNT(*) AS n FROM kernel_queue q
        JOIN kernel_node_state s ON s.task_id=q.task_id AND s.node_id=q.node_id
        WHERE q.task_id=? AND q.state='queued' AND s.paused=1`).get(graphId) as { n: number };
      const inbox = db.prepare(`SELECT COUNT(*) AS n FROM kernel_module_inbox i
        JOIN kernel_node_state s ON s.task_id=i.task_id AND s.node_id=i.module_id
        WHERE i.task_id=? AND i.processed=0 AND s.paused=1`).get(graphId) as { n: number };
      return queued.n + inbox.n;
    } finally {
      db.close();
    }
  };
  const phaseOf = async (graphId: string) => (await request(`/api/tasks/${graphId}`)).body as { phase?: string };
  // The facts behind a phase, read straight from the daemon's database: a
  // failure that only says "still idle" hides which row the graph is waiting on.
  const stallFacts = (graphId: string) => {
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    try {
      const count = (sql: string) => {
        try { return db.prepare(sql).all(graphId) as unknown as Record<string, unknown>[]; } catch (error) { return [{ error: String(error) }]; }
      };
      return JSON.stringify({
        task: count('SELECT phase,paused FROM tasks WHERE id=?'),
        nodes: count('SELECT node_id,status FROM kernel_nodes WHERE task_id=?'),
        queue: count('SELECT seq,node_id,state FROM kernel_queue WHERE task_id=?'),
        executions: count('SELECT id,node_id,state FROM kernel_executions WHERE task_id=?'),
        operations: count('SELECT id,module_id,state,error FROM kernel_module_operations WHERE task_id=?'),
        questions: count('SELECT id,status FROM questions WHERE task_id=?'),
        transitions: count('SELECT id,module_id,verdict,state_after,reason FROM kernel_module_transitions WHERE task_id=?'),
      });
    } finally {
      db.close();
    }
  };
  const waitPhase = async (graphId: string, wanted: string) => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if ((await phaseOf(graphId)).phase === wanted) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const last = await phaseOf(graphId);
    throw new Error(`the graph stayed ${JSON.stringify(last)} instead of reaching ${wanted}; facts ${stallFacts(graphId)}`);
  };

  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { stalls: { secretRef: 'GRAPH_STALL_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
        baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'stalls' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_STALL_KEY: 'stalls-synthetic' }, extraArgs: ['--execute'] });

    plan = () => [
      { id: 'create-stalled', name: 'graph_create', args: { requestId: 'create-stalled', definition: FAILING_DEFINITION } },
      {
        id: 'run-stalled', name: 'graph_send',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), nodeId: 'failing', input: 'job', value: { marker: 'go' } },
      },
      {
        id: 'failed-operations', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), query: 'operations' },
        until: results => (results.get('failed-operations') ?? '').includes('"passed":false'),
      },
      {
        // Nobody asks this graph to complete: the phase has to come from the
        // work that ended, not from a completion request.
        id: 'parked-summary', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), query: 'summary' },
        before: async () => { await waitPhase(answeredGraphId(master, 'create-stalled'), 'blocked'); },
      },
      {
        id: 'send-again', name: 'graph_send',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), nodeId: 'failing', input: 'job', value: { marker: 'again' } },
      },
      {
        id: 'reparked-summary', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), query: 'summary' },
        before: async () => {
          const id = answeredGraphId(master, 'create-stalled');
          await expect.poll(() => settledOperationCount(id), { timeout: 60_000, interval: 250 }).toBe(2);
          await waitPhase(id, 'blocked');
        },
      },
      {
        // A paused target keeps what is sent to it waiting forever. That is not
        // live work: the graph must keep saying blocked, not fall back to
        // running just because somebody sent it something.
        id: 'pause-node', name: 'graph_control',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), action: 'pause', moduleId: 'failing', requestId: 'stall-pause' },
      },
      {
        id: 'send-while-paused', name: 'graph_send',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), nodeId: 'failing', input: 'job', value: { marker: 'while-paused' } },
      },
      {
        id: 'still-blocked', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), query: 'summary' },
        before: async () => {
          const id = answeredGraphId(master, 'create-stalled');
          await expect.poll(() => pendingWorkForPaused(id), { timeout: 30_000, interval: 200 }).toBe(1);
          await waitPhase(id, 'blocked');
          // It really did not run: the send is waiting, not done.
          expect(operationCount(id)).toBe(2);
        },
      },
      {
        // And the waiting delivery was real work: resuming the module runs it.
        id: 'resume-node', name: 'graph_control',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), action: 'resume', moduleId: 'failing', requestId: 'stall-resume' },
      },
      {
        id: 'parked-again', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-stalled')), query: 'summary' },
        before: async () => {
          const id = answeredGraphId(master, 'create-stalled');
          await expect.poll(() => settledOperationCount(id), { timeout: 60_000, interval: 250 }).toBe(3);
          await waitPhase(id, 'blocked');
        },
      },
    ];

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the check and stop touching the graph.', requestId: 'stall-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await waitForStep(master, 'parked-again', 120_000);

    const graphId = answeredGraphId(master, 'create-stalled');

    // The graph parked itself with a node that really failed, and no completion
    // was ever requested.
    const parked = JSON.parse(master.results.get('parked-summary')!) as { phase: string };
    expect(parked.phase).toBe('blocked');
    expect(master.results.has('complete-stalled')).toBe(false);

    // Work that arrives later really runs again: the graph was not frozen into
    // a phase it can never leave.
    expect(operationCount(graphId)).toBe(3);

    // That work failed too, so the graph parks again instead of staying loose.
    const reparked = JSON.parse(master.results.get('reparked-summary')!) as { phase: string };
    expect(reparked.phase).toBe('blocked');

    // Work sent to a paused target is not live work: it waited, the graph stayed
    // blocked, and resuming the module ran it for real.
    const stillBlocked = JSON.parse(master.results.get('still-blocked')!) as { phase: string };
    expect(stillBlocked.phase).toBe('blocked');
    expect(operationCount(graphId)).toBe(3);
    expect(pendingWorkForPaused(graphId)).toBe(0);
    const parkedAgain = JSON.parse(master.results.get('parked-again')!) as { phase: string };
    expect(parkedAgain.phase).toBe('blocked');

    const rows = await request(`/api/tasks/${graphId}`);
    expect((rows.body as { phase?: string }).phase).toBe('blocked');
  } finally {
    await daemon?.close();
    await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
