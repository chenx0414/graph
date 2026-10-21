import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

// The graph node lane has to survive a daemon that dies mid-turn, on the PiG
// kernel.
//
// Three facts decide what a dead turn means, and the kernel keeps all three:
// whether the kernel finished the turn, whether the turn was ever accepted as
// an input, and whether the turn ever reached the model.
//
//   - A turn the kernel finished is an answer the Graph already paid for. The
//     node settles from it, and the model is not asked again.
//   - A turn that was accepted but never sent is sent again, with the
//     configuration it was admitted with, not the configuration the catalog
//     happens to hold now.
//   - A turn that was already at the model is neither. The credential was
//     spent and the side effects may have happened, so the node waits for the
//     user instead of spending the credential twice.

interface ProviderTool { function?: { name?: string } }
interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }
interface ProviderRequest { master: boolean; body: ProviderBody }

const PROPOSAL = {
  requirementVersion: 1,
  summary: '节点恢复',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '节点恢复', protocols: { result: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Do the work.',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
      outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
    edges: { first: { from: 'work.done', to: 'check.start', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
};

interface LaneProvider {
  requests: ProviderRequest[];
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * laneProvider answers by role: the master proposes, the master dispatches,
 * the worker submits.
 *
 * The master can also be told to keep its last request open, which holds the
 * credential slot the worker needs. That is how a node turn is caught between
 * the kernel accepting the input and the model receiving it.
 */
async function laneProvider(options: { hold: 'master' | 'worker' | 'none' }): Promise<LaneProvider> {
  const requests: ProviderRequest[] = [];
  let proposed = false;
  let dispatched = false;
  let masterTurns = 0;
  let workerTurns = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const names = (body.tools ?? []).map(tool => tool.function?.name);
    const master = names.includes('propose_graph') || names.includes('graph_send');
    requests.push({ master, body });
    const lastUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const toolCall = (id: string, name: string, args: unknown) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (master) {
      masterTurns += 1;
      if (!proposed) {
        proposed = true;
        response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
      const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content ?? ''));
      if (wake && !dispatched) {
        dispatched = true;
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'start-work', type: 'function',
          function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId: 'work', input: 'job', value: { text: 'Run the work' } }) } }] }, finish_reason: null }] }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
      // The master keeps a request open: the credential slot stays taken, so
      // the node's own send waits for it.
      if (options.hold === 'master' && masterTurns >= 3) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Still working.' }, finish_reason: null }] }));
        return;
      }
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Dispatched.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    // The worker submits its output, then answers.
    const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
    if (!submitted) {
      workerTurns += 1;
      // The worker keeps its request open: the turn is at the model when the
      // daemon dies.
      if (options.hold === 'worker' && workerTurns === 1) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Working on it.' }, finish_reason: null }] }));
        return;
      }
      response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
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

/** workerRequests are the provider requests the graph's worker made. */
function workerRequests(provider: LaneProvider): ProviderRequest[] {
  return provider.requests.filter(entry => !entry.master);
}

test('an interrupted node turn that never reached the model is sent again with the configuration it was admitted with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-resend-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Node recovery project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  const provider = await laneProvider({ hold: 'master' });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let state = '';
  const configPath = join(root, 'graph.config.json');
  const database = join(root, 'state/tasks.sqlite');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_RECOVERY_KEY' } },
      // One credential slot: the master holds it while the worker waits, so
      // the worker's input is accepted by the kernel and never sent.
      limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-node-recovery', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_NODE_RECOVERY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'lane-1',
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
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 500 }).toBe('succeeded');

    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
      targetBranch: draft.targetBranch ?? 'main', requestId: 'lane-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The node's input must be accepted by the kernel and never reach the
    // model: the credential slot is taken by the master.
    const admitted = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const execution = db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id='work' ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
        if (!execution) return { execution: '', admitted: false, sent: false };
        const submission = db.prepare("SELECT COUNT(*) AS n FROM graph_durable_submissions WHERE json_extract(request_id,'$') LIKE ?").get(`%${execution.id}:attempt:%`) as { n: number };
        const call = db.prepare("SELECT COUNT(*) AS n FROM kernel_provider_calls WHERE execution_id=?").get(execution.id) as { n: number };
        return { execution: execution.id, admitted: submission.n > 0, sent: call.n > 0 };
      } finally { db.close(); }
    };
    const deadlineAdmission = Date.now() + 60_000;
    while (Date.now() < deadlineAdmission && !admitted().admitted) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!admitted().admitted) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
        state = JSON.stringify({
          admitted: admitted(),
          executions: db.prepare("SELECT id,state,attempt,waiting_slot FROM kernel_executions").all(),
          queue: db.prepare("SELECT seq,node_id,state,reason FROM kernel_queue").all(),
          nodes: db.prepare("SELECT node_id,status FROM kernel_nodes").all(),
          sessions: db.prepare("SELECT instance_id,session_id FROM node_sessions").all(),
          instances: db.prepare("SELECT id,task_id,node_id FROM instances").all(),
          submissions: db.prepare("SELECT conversation_id,request_id,status FROM graph_durable_submissions").all(),
          events: (Array.isArray(events.body) ? events.body : []).slice(-30),
        }, null, 1);
      } finally { db.close(); }
    }
    expect(admitted().admitted, `the node never admitted its input:\n${state}`).toBe(true);
    expect(admitted().sent, 'the worker reached the model before the daemon died').toBe(false);
    expect(workerRequests(provider)).toHaveLength(0);

    // The catalog moves on while the daemon is down. The recovered input
    // keeps the configuration it was admitted with.
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.models.entries[0].maxTokens = 4096;
    await writeFile(configPath, JSON.stringify(edited));
    daemon.child.kill('SIGKILL');
    await daemon.close();

    daemon = await start();
    // The node waits for the user: the daemon found the node interrupted and
    // did not run it on its own.
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

    let nodeStatus = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      nodeStatus = nodes.find(node => node.id === 'work')?.status ?? '';
      if (nodeStatus === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (nodeStatus !== 'succeeded') {
      const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-40)
        .map((event: { cursor?: number; type?: string; data?: unknown }) =>
          `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 240)}`);
      expect(nodeStatus, `events:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe('succeeded');
    }
    expect(nodeStatus).toBe('succeeded');

    // The worker was asked exactly once: the accepted input was sent again,
    // not admitted twice.
    const worker = workerRequests(provider);
    expect(worker).toHaveLength(2);
    // The recovered request carries the configuration the input was admitted
    // with, not the one the catalog holds now.
    const sent = worker[0]!.body as unknown as { max_tokens?: number; max_completion_tokens?: number };
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(512);
  } finally {
    await writeFile('/tmp/pig-node-recovery-debug.log', JSON.stringify({
      requests: provider.requests.map(entry => ({
        master: entry.master,
        tools: (entry.body.tools ?? []).map(tool => tool.function?.name),
      })),
      state,
      stderr: daemon?.stderr ?? '',
    }, null, 2));
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);

test('an interrupted node turn that was already at the model is not sent again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-atmodel-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Node recovery project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  const provider = await laneProvider({ hold: 'worker' });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let state = '';
  const configPath = join(root, 'graph.config.json');
  const database = join(root, 'state/tasks.sqlite');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_RECOVERY_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-node-recovery', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_NODE_RECOVERY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'lane-1',
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
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 500 }).toBe('succeeded');

    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
      targetBranch: draft.targetBranch ?? 'main', requestId: 'lane-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The worker's turn reaches the model and stays there.
    await expect.poll(() => workerRequests(provider).length, { timeout: 60000, interval: 250 }).toBe(1);
    const atModel = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const execution = db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id='work' ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
        if (!execution) return { admitted: false, sent: false };
        const submission = db.prepare("SELECT COUNT(*) AS n FROM graph_durable_submissions WHERE json_extract(request_id,'$') LIKE ?").get(`%${execution.id}:attempt:%`) as { n: number };
        const call = db.prepare("SELECT COUNT(*) AS n FROM kernel_provider_calls WHERE execution_id=?").get(execution.id) as { n: number };
        return { admitted: submission.n > 0, sent: call.n > 0 };
      } finally { db.close(); }
    };
    const deadlineModel = Date.now() + 30_000;
    while (Date.now() < deadlineModel && !atModel().sent) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!atModel().sent) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        state = JSON.stringify({
          atModel: atModel(),
          executions: db.prepare("SELECT id,state,attempt FROM kernel_executions").all(),
          queue: db.prepare("SELECT seq,node_id,state,reason FROM kernel_queue").all(),
        }, null, 1);
      } finally { db.close(); }
    }
    expect(atModel().sent, `the worker never reached the model:\n${state}`).toBe(true);

    daemon.child.kill('SIGKILL');
    await daemon.close();

    daemon = await start();
    // The recovery stops the turn instead of sending it again: the credential
    // was spent and the side effects may have happened.
    const stopped = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db.prepare("SELECT state,reason FROM kernel_queue WHERE task_id=? AND node_id='work'").get(taskId) as { state: string; reason: string } | undefined;
      } finally { db.close(); }
    };
    const deadlineStopped = Date.now() + 30_000;
    while (Date.now() < deadlineStopped && stopped()?.state !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const item = stopped();
    expect(item?.state, `the recovery did not stop the turn:\n${state}`).toBe('failed');
    expect(item?.reason ?? '').toMatch(/reconcile/i);

    // The user may resume the node. The input is still not sent again.
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(workerRequests(provider)).toHaveLength(1);
    const task = await request(`/api/tasks/${taskId}`);
    const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
    expect(nodes.find(node => node.id === 'work')?.status).not.toBe('succeeded');
  } finally {
    await writeFile('/tmp/pig-node-at-model-debug.log', JSON.stringify({
      requests: provider.requests.map(entry => ({
        master: entry.master,
        tools: (entry.body.tools ?? []).map(tool => tool.function?.name),
      })),
      state,
      stderr: daemon?.stderr ?? '',
    }, null, 2));
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);

test('an interrupted node turn the kernel already finished settles the node without asking the model again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-finished-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Node recovery project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  const provider = await laneProvider({ hold: 'none' });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let state = '';
  const configPath = join(root, 'graph.config.json');
  const database = join(root, 'state/tasks.sqlite');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_RECOVERY_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-node-recovery', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_NODE_RECOVERY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    // The Graph cannot record the node's completion. The kernel still finishes
    // the turn: the turn is the kernel's, and only the acknowledgement is the
    // Graph's.
    const fault = new DatabaseSync(join(root, 'state/tasks.sqlite'));
    fault.exec("PRAGMA busy_timeout=5000; CREATE TRIGGER reject_node_completion BEFORE UPDATE OF state ON kernel_executions WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'E2E storage acknowledgement failure'); END");
    fault.close();
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'lane-1',
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
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 500 }).toBe('succeeded');

    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
      targetBranch: draft.targetBranch ?? 'main', requestId: 'lane-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The kernel finishes the turn: the worker submitted and answered.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && workerRequests(provider).length < 2) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (workerRequests(provider).length < 2) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        state = JSON.stringify({
          worker: workerRequests(provider).length,
          executions: db.prepare("SELECT id,state,attempt FROM kernel_executions").all(),
          submissions: db.prepare("SELECT conversation_id,request_id,status FROM graph_durable_submissions").all(),
        }, null, 1);
      } finally { db.close(); }
    }
    expect(workerRequests(provider).length, `the worker never finished its turn:\n${state}`).toBe(2);
    // The Graph could not record the completion, so the node is still running.
    await expect.poll(async () => {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      return nodes.find(node => node.id === 'work')?.status;
    }, { timeout: 30000, interval: 250 }).not.toBe('succeeded');

    daemon.child.kill('SIGKILL');
    await daemon.close();
    const repair = new DatabaseSync(database);
    repair.exec('PRAGMA busy_timeout=5000; DROP TRIGGER reject_node_completion');
    repair.close();

    daemon = await start();
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

    let nodeStatus = '';
    const settle = Date.now() + 90_000;
    while (Date.now() < settle) {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      nodeStatus = nodes.find(node => node.id === 'work')?.status ?? '';
      if (nodeStatus === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (nodeStatus !== 'succeeded') {
      const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-30)
        .map((event: { cursor?: number; type?: string; data?: unknown }) =>
          `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 240)}`);
      expect(nodeStatus, `events:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe('succeeded');
    }
    expect(nodeStatus).toBe('succeeded');
    // The kernel kept the answer it already had. The model was not asked
    // again.
    expect(workerRequests(provider)).toHaveLength(2);
  } finally {
    await writeFile('/tmp/pig-node-finished-debug.log', JSON.stringify({
      requests: provider.requests.map(entry => ({
        master: entry.master,
        tools: (entry.body.tools ?? []).map(tool => tool.function?.name),
      })),
      state,
      stderr: daemon?.stderr ?? '',
    }, null, 2));
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);
