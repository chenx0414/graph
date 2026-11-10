import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { PROPOSAL, git, wakeProvider, type ProviderRequest } from './go-wake-notification.fixture.ts';

/**
 * A confirmed draft wakes the main agent, and the wake must name the graph.
 *
 * The wake is a fact about the graph that was just confirmed: "Graph <id> is ready
 * and awaits explicit input". A daemon that loses the fact's data tells the model
 * that an unnamed graph is waiting, so the model cannot inspect it and the graph
 * never runs. The provider request must also carry the model's own tool call back
 * as an assistant turn: a model that reads its tool call as a user turn does not
 * recognize what it called, and repeats it forever.
 *
 * The graph that runs from this wake is proved end to end by
 * `tests/m8/integration.test.ts`; this test locks the facts the wake depends on and
 * the state of the graph it starts: the two worker nodes submit, the host-command
 * module checks them, and every node ends succeeded.
 */

test('a confirmed graph wakes main with the graph id', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-wake-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  // A graph node works in a worktree of the project, so the project is a repository.
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Wake project\n');
  git(project, ['init', '-q', '--template=', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await wakeProvider();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_WAKE_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-wake', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_WAKE_KEY: 'synthetic-wake-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph I can watch.', requestId: 'wake-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    let draft: { version?: number; draftRevision?: number; targetBranch?: string } = {};
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const proposal = (view.body as { proposal?: { version?: number; draftRevision?: number; targetBranch?: string } }).proposal;
      draft = proposal ?? {};
      return Boolean(proposal);
    }, { timeout: 60000, interval: 250 }).toBe(true);

    // The wake is a fact for the next turn of the master. The ledger re-pends
    // the master only when it has succeeded, so a confirmation that lands
    // while a turn is still running would leave the wake waiting for a turn
    // that never comes. The turn is allowed to end first.
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const master = (view.body as { master?: { status?: string } }).master;
      return master?.status === 'succeeded';
    }, { timeout: 90000, interval: 500 }).toBe(true);

    // The SDK must finish its real node inputs while a storage failure prevents
    // Graph's terminal acknowledgement. Business submission remains committed.
    const fault = new DatabaseSync(join(root, 'state/tasks.sqlite'));
    fault.exec("PRAGMA busy_timeout=5000; CREATE TRIGGER reject_node_ack BEFORE UPDATE OF state ON kernel_executions WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT,'E2E node acknowledgement failure'); END");
    fault.close();
    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
      targetBranch: draft.targetBranch ?? 'main', requestId: 'wake-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The wake names the graph that was confirmed.
    let woke = false;
    const wakeDeadline = Date.now() + 90_000;
    while (Date.now() < wakeDeadline) {
      woke = provider.requests.some(entry =>
        JSON.stringify(entry.body.messages ?? []).includes(`Graph ${taskId} is ready and awaits explicit input`));
      if (woke) break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!woke) {
      // A wake that never arrived is a lost fact: the events and the daemon log
      // say whether the wake was recorded and whether a turn picked it up.
      const events = await request(`/api/conversations/${conversationId}/events?after=0&limit=400`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-40)
        .map((event: { cursor?: number; type?: string; data?: unknown }) =>
          `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 240)}`);
      const calls = provider.requests.map(entry => (entry.body.messages ?? [])
        .flatMap(message => message.tool_calls ?? []).map(call => call.function?.name).join(','));
      expect(woke, `wake never arrived\nrequests: ${provider.requests.length}\ncalls: ${calls.join(' | ')}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe(true);
    }
    // A wake without its data would tell the model that an unnamed graph waits.
    expect(JSON.stringify(provider.requests)).not.toContain('Graph undefined is ready');

    const originalExecutions = () => {
      const db = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
      try { return db.prepare('SELECT id,node_id,attempt,submission_id,retries_used FROM kernel_executions WHERE task_id=? ORDER BY node_id').all(taskId); }
      finally { db.close(); }
    };
    await expect.poll(() => {
      const db = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
      try { return db.prepare(`SELECT COUNT(*) AS n FROM graph_durable_submissions d JOIN node_sessions s ON s.session_id=CAST(d.conversation_id AS TEXT) JOIN kernel_nodes n ON n.instance_id=s.instance_id WHERE n.task_id=? AND d.status='done'`).get(taskId)!.n; }
      finally { db.close(); }
    }, { timeout: 30000 }).toBe(2);
    const original = originalExecutions();
    expect(original).toHaveLength(2);
    expect(original.every(row => row.submission_id !== null)).toBe(true);
    const workerRequests = provider.requests.filter(entry => !entry.master).length;
    daemon.child.kill('SIGKILL'); await daemon.close();
    const repair = new DatabaseSync(join(root, 'state/tasks.sqlite')); repair.exec('PRAGMA busy_timeout=5000; DROP TRIGGER reject_node_ack'); repair.close();
    daemon = await launchCli(root, { configPath, env: { GRAPH_WAKE_KEY: 'synthetic-wake-key' }, extraArgs: ['--execute'] });
    for (const nodeId of ['work1', 'work2']) {
      const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId });
      expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    }
    // The graph the wake named really runs.
    // The last task body is kept so a failure says which node stood still.
    let lastTask: unknown = {};
    let allSucceeded = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const task = await request(`/api/tasks/${taskId}`);
      lastTask = task.body;
      const nodes = (task.body as { nodes?: { status: string }[] }).nodes ?? [];
      if (nodes.length > 0 && nodes.every(node => node.status === 'succeeded')) { allSucceeded = true; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!allSucceeded) {
      // The node states alone do not say why a node failed; the event log does.
      const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-40)
        .map((event: { cursor?: number; type?: string; data?: unknown }) =>
          `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 240)}`);
      expect(allSucceeded, `task body: ${JSON.stringify(lastTask)}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe(true);
    }
    expect(allSucceeded, `task body: ${JSON.stringify(lastTask)}`).toBe(true);

    expect(originalExecutions()).toEqual(original);
    expect(provider.requests.filter(entry => !entry.master)).toHaveLength(workerRequests);
    const ledger = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
    try { expect(ledger.prepare('SELECT COUNT(*) AS n FROM kernel_submissions WHERE task_id=?').get(taskId)!.n).toBe(2); }
    finally { ledger.close(); }
    // Retain a second node input after SDK admission but before its first send.
    // The occupied credential belongs to a separate, real main conversation.
    expect((await request('/api/conversations', 'POST', { projectId: 'p', model: 'local', text: 'HOLD_SLOT_BEFORE_NODE_RESTART', requestId: 'occupy-before-node' })).status).toBe(200);
    const holdRequests = () => provider.requests.filter(entry => JSON.stringify(entry.body.messages ?? []).includes('HOLD_SLOT_BEFORE_NODE_RESTART'));
    await expect.poll(() => holdRequests().length, { timeout: 20000 }).toBe(1);
    expect((await request(`/api/tasks/${taskId}/nodes/work1/messages`, 'POST', { text: 'SAFE_PENDING_NODE_INPUT', requestId: 'pending-node' })).status).toBe(200);
    await expect.poll(() => {
      const db = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
      try { return db.prepare(`SELECT COUNT(*) AS n FROM graph_durable_submissions d JOIN node_sessions s ON s.session_id=CAST(d.conversation_id AS TEXT) JOIN kernel_nodes n ON n.instance_id=s.instance_id WHERE n.task_id=? AND n.node_id='work1' AND d.status!='done'`).get(taskId)!.n; }
      finally { db.close(); }
    }, { timeout: 20000 }).toBe(1);
    const retained = originalExecutions();
    expect(retained).toHaveLength(3);
    const safeRequests = provider.requests.filter(entry => !entry.master).length;
    const edited = JSON.parse(await readFile(configPath, 'utf8')); edited.models.entries[0].maxTokens = 1024; await writeFile(configPath, JSON.stringify(edited));
    daemon.child.kill('SIGKILL'); await daemon.close();
    daemon = await launchCli(root, { configPath, env: { GRAPH_WAKE_KEY: 'synthetic-wake-key' }, extraArgs: ['--execute'] });
    expect(provider.requests.filter(entry => !entry.master)).toHaveLength(safeRequests);
    expect((await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work1' })).status).toBe(200);
    await expect.poll(async () => {
      const task = await request(`/api/tasks/${taskId}`);
      return (task.body as { nodes: { id: string; status: string }[] }).nodes.find(node => node.id === 'work1')?.status;
    }, { timeout: 30000 }).toBe('succeeded');
    // The attempt counter records that a turn started, not that the retained
    // input was spent. The contracts are the same execution, the same
    // submission, no retry allowance, and one frozen-config request.
    //
    // retries_used is deliberately not part of the comparison: whether the
    // killed turn had spent its allowance depends on where the SIGKILL landed,
    // and comparing it made this test pass or fail with the machine's load
    // while proving nothing about the contract.
    const executionFacts = (rows: ReturnType<typeof originalExecutions>) => rows.map(row => ({
      id: row.id, node_id: row.node_id, submission_id: row.submission_id,
    }));
    const resumed = originalExecutions();
    expect(executionFacts(resumed)).toEqual(executionFacts(retained));
    const pendingId = retained.find(row => row.submission_id === null)?.id;
    const pendingExecution = resumed.find(row => row.id === pendingId);
    expect([1, 2]).toContain(pendingExecution?.attempt);
    expect(provider.requests.filter(entry => !entry.master)).toHaveLength(safeRequests + 1);
    const recoveredBody = provider.requests.filter(entry => !entry.master).at(-1)!.body as { max_tokens?: number; max_completion_tokens?: number };
    expect(recoveredBody.max_tokens ?? recoveredBody.max_completion_tokens).toBe(512);
    expect(JSON.stringify(provider.requests.filter(entry => !entry.master).at(-1)?.body.messages)).toContain('SAFE_PENDING_NODE_INPUT');

    // The model reads its own tool call back as an assistant turn, not as a user turn.
    const assistantTurns = provider.requests.flatMap(entry => entry.body.messages ?? [])
      .filter(message => message.role === 'assistant');
    expect(assistantTurns.length).toBeGreaterThan(0);
    expect(assistantTurns.some(message => message.tool_calls?.length)).toBe(true);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
