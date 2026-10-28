import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

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

interface ProviderTool { function?: { name?: string } }
interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }
interface ProviderRequest {
  master: boolean;
  body: ProviderBody;
}

/** Real Git: the fixture project is a repository, so the daemon has a branch to work on. */
function git(cwd: string, args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Graph Test', GIT_AUTHOR_EMAIL: 'graph@example.invalid',
      GIT_COMMITTER_NAME: 'Graph Test', GIT_COMMITTER_EMAIL: 'graph@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  });
}

const PROPOSAL = {
  requirementVersion: 1,
  summary: '通知链路',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '通知链路', protocols: { result: { type: 'object' } },
    nodes: Object.fromEntries(['work1', 'work2'].map(id => [id, { recipe: 'coder@1', model: 'local', task: 'Do the work.',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } }])),
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
      outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
    edges: { first: { from: 'work1.done', to: 'check.start', enabled: true },
      second: { from: 'work2.done', to: 'check.start', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
};

/** A provider that answers by role: main proposes, main dispatches, a worker submits. */
async function wakeProvider() {
  const requests: ProviderRequest[] = [];
  // The master's next turn still carries the wake in its history, so the
  // dispatch happens once; a second graph_send would deliver the same input twice.
  let dispatched = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    requests.push({ master, body });
    const lastUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    if (master && JSON.stringify(lastUser?.content).includes('HOLD_SLOT_BEFORE_NODE_RESTART')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': occupied credential slot\n\n');
      return;
    }
    const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content ?? ''));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const toolCall = (id: string, name: string, args: unknown) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const proposed = requests.some(entry => entry.body.messages?.some(message =>
      message.tool_calls?.some(call => call.function?.name === 'propose_graph')));
    if (master && !wake && !proposed) {
      response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (master && wake && !dispatched) {
      dispatched = true;
      const calls = ['work1', 'work2'].map((nodeId, index) => ({ index, id: `start-${nodeId}`, type: 'function',
        function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId, input: 'job', value: { text: 'Run the work' } }) } }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }] }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!master) {
      const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
      if (!submitted) {
        response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
    }
    // Every response reports usage: a turn without usage is a turn whose cost
    // nobody can prove, and the test must not depend on how that is treated.
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

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
    const beforeHold = provider.requests.length;
    expect((await request('/api/conversations', 'POST', { projectId: 'p', model: 'local', text: 'HOLD_SLOT_BEFORE_NODE_RESTART', requestId: 'occupy-before-node' })).status).toBe(200);
    await expect.poll(() => provider.requests.length, { timeout: 20000 }).toBe(beforeHold + 1);
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
    const executionFacts = (rows: ReturnType<typeof originalExecutions>) => rows.map(row => ({
      id: row.id, node_id: row.node_id, submission_id: row.submission_id, retries_used: row.retries_used,
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
