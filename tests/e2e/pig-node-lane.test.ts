import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

const run = promisify(execFile);

// The graph node lane is the last thing the TypeScript sidecar still carries.
//
// A node's session must live in the same durable namespace as the main
// agent's, be driven by the same PiG kernel, and never need a second kernel
// over the same tables. The proof is a real graph: the main agent proposes
// it, the user confirms it, the master dispatches the node's input, and the
// node's own turn runs and submits.

interface ProviderTool { function?: { name?: string } }
interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }
interface ProviderRequest { master: boolean; body: ProviderBody }

const PROPOSAL = {
  requirementVersion: 1,
  summary: '节点泳道',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '节点泳道', protocols: { result: { type: 'object' } },
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

/** A provider that answers by role: main proposes, main dispatches, the worker submits. */
async function laneProvider() {
  const requests: ProviderRequest[] = [];
  let dispatched = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
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
    const proposed = requests.some(entry => entry.body.messages?.some(message =>
      message.tool_calls?.some(call => call.function?.name === 'propose_graph')));
    if (master && !proposed) {
      response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content ?? ''));
    if (master && wake && !dispatched) {
      dispatched = true;
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'start-work', type: 'function',
        function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId: 'work', input: 'job', value: { text: 'Run the work' } }) } }] }, finish_reason: null }] }));
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

/** sidecarProcesses are the TypeScript durable sidecars the daemon started. */
async function sidecarProcesses(pid: number): Promise<string[]> {
  const listing = await run('ps', ['-o', 'pid=,ppid=,command=', '-ax'], { timeout: 20000 });
  return listing.stdout.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    .map(line => {
      const parts = line.split(/\s+/);
      return { ppid: Number(parts[1]), command: parts.slice(2).join(' ') };
    })
    .filter(entry => entry.ppid === pid && entry.command.includes('durable-service'))
    .map(entry => entry.command);
}

test('a graph node runs its turn on the PiG kernel, without the TypeScript sidecar', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-lane-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Node lane project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  const provider = await laneProvider();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_LANE_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-node-lane', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_NODE_LANE_KEY: 'synthetic-node-lane-key' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
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

    // The node's own turn has to finish: the node submits its output.
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

    // The node's session lives in the PiG durable namespace: the kernel that
    // holds the main agent's conversation holds the node's one too.
    const database = join(root, 'state/tasks.sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    let sessionId: string;
    let instanceId: string;
    let identities: string;
    try {
      const row = db.prepare('SELECT instance_id,session_id FROM node_sessions LIMIT 1').get() as { instance_id: string; session_id: string } | undefined;
      expect(row, 'the node recorded no session').toBeTruthy();
      instanceId = row!.instance_id;
      sessionId = row!.session_id;
      identities = db.prepare(`SELECT r.content AS content FROM graph_durable_document_revisions r
        JOIN graph_durable_documents d ON d.id = r.document_id
        WHERE json_extract(d.kind, '$') = 'graph.identities'`).all()
        .map(entry => String((entry as { content: string }).content)).join('');
    } finally { db.close(); }
    // The identity index names the node's own conversation.
    expect(identities).toContain(instanceId);
    expect(identities).toContain(sessionId);
    // The node ran on the PiG kernel: its own conversation holds the admission
    // of its own turn, and the turn carries the attempt.
    const proof = new DatabaseSync(database, { readOnly: true });
    try {
      const admissions = proof.prepare('SELECT conversation_id,request_id,status FROM graph_durable_submissions').all() as
        { conversation_id: unknown; request_id: string; status: string }[];
      const nodeAdmissions = admissions.filter(entry => String(entry.conversation_id) === sessionId);
      expect(nodeAdmissions.length, 'the node conversation holds no admission').toBeGreaterThan(0);
      expect(nodeAdmissions.some(entry => entry.status === 'done')).toBe(true);
      // The request id is stored as the kernel stores it: a JSON string.
      const requestIds = nodeAdmissions.map(entry => JSON.parse(entry.request_id) as string);
      expect(requestIds.some(id => /:attempt:\d+$/.test(id)),
        `the node admissions are ${JSON.stringify(requestIds)}`).toBe(true);
      // The node's own transcript is the Graph's: the answer and the submit
      // the model made are both in it.
      const entries = proof.prepare("SELECT role,kind FROM node_entries WHERE node_id='work'").all() as
        { role: string; kind: string }[];
      expect(entries.some(entry => entry.role === 'assistant')).toBe(true);
      expect(entries.some(entry => entry.kind === 'call')).toBe(true);
    } finally { proof.close(); }
    // The node ran on the PiG kernel: the daemon started no sidecar for it.
    expect(await sidecarProcesses(daemon.child.pid!)).toEqual([]);
  } finally {
    await writeFile('/tmp/pig-node-lane-debug.log', JSON.stringify({
      requests: provider.requests.map(entry => ({
        master: entry.master,
        tools: (entry.body.tools ?? []).map(tool => tool.function?.name),
        messages: (entry.body.messages ?? []).map(message => ({ role: message.role, content: message.content })),
      })),
      stderr: daemon?.stderr ?? '',
    }, null, 2));
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
