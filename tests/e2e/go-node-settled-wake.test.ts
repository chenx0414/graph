import { DatabaseSync } from 'node:sqlite';
import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A node that finishes must wake the supervisor, or the graph stalls silently.
 *
 * Measured before this wake existed: `work` settled succeeded inside a graph,
 * nothing told main, and main stayed idle for five minutes while the graph
 * looked "in progress" - the next step (dispatching `review`) was never taken.
 * Nothing failed, so no failure path ran; the graph simply stopped moving.
 *
 * The wake is the fact that a node's turn landed and its output is committed.
 * This case proves it end to end: after `work` settles, the harness must wake
 * main with a message naming the node, the graph and the status, and main -
 * which is only allowed to react to that wake - starts `review`. The test never
 * sends the second input itself, so `review` reaching succeeded is the proof
 * that the wake did the work.
 */

interface ProviderTool { function?: { name?: string } }
interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }
interface ProviderRequest { master: boolean; body: ProviderBody }

/** Real Git: graph nodes work in worktrees of a repository. */
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
  summary: '节点落定唤醒',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '节点落定唤醒', protocols: { result: { type: 'object' } },
    nodes: Object.fromEntries(['work', 'review'].map(id => [id, {
      recipe: 'coder@1', model: 'local', task: `Do the ${id} step.`,
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } },
      submission: { required: ['done'] },
    }])),
    modules: {
      check: {
        type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
        outputs: { result: { protocol: 'result' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' },
      },
    },
    edges: {
      first: { from: 'work.done', to: 'check.start', enabled: true },
      second: { from: 'review.done', to: 'check.start', enabled: true },
    },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
};

/** A provider that answers by role: main proposes, then acts only on the wakes it is given. */
async function settledProvider() {
  const requests: ProviderRequest[] = [];
  let dispatchedWork = false;
  let dispatchedReview = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    requests.push({ master, body });
    const lastUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    const last = JSON.stringify(lastUser?.content ?? '');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const toolCall = (id: string, name: string, args: unknown) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
    const send = (graphId: string, nodeId: string) => {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(toolCall(`start-${nodeId}`, 'graph_send', { graphId, nodeId, input: 'job', value: { text: `Run ${nodeId}` } }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
    };
    const ready = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(last);
    const settled = /Node ([A-Za-z0-9_.-]+) in graph ([a-f0-9-]+) settled \((succeeded|failed|skipped)\)/.exec(last);
    const proposed = requests.some(entry => entry.body.messages?.some(message =>
      message.tool_calls?.some(call => call.function?.name === 'propose_graph')));
    if (master && !ready && !settled && !proposed) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    // Only the wake is allowed to start the next step: the test sends no input.
    if (master && settled && settled[1] === 'work' && !dispatchedReview) {
      dispatchedReview = true;
      send(settled[2]!, 'review');
      return;
    }
    if (master && ready && !dispatchedWork) {
      dispatchedWork = true;
      send(ready[1]!, 'work');
      return;
    }
    if (!master) {
      const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
      if (!submitted) {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Node finished' } } } }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
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

test('a settled node wakes main, which can then start the next step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-settled-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Settled project\n');
  git(project, ['init', '-q', '--template=', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await settledProvider();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_SETTLED_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-settled', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_SETTLED_KEY: 'synthetic-settled-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Run a two-step graph without me pushing it.', requestId: 'settled-1',
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
      targetBranch: draft.targetBranch ?? 'main', requestId: 'settled-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The fact must name the node, the graph and the status; a wake without them
    // tells main that something settled but not what to inspect.
    let settledFact = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const found = provider.requests
        .map(entry => /Node work in graph ([a-f0-9-]+) settled \((succeeded)\)/.exec(JSON.stringify(entry.body.messages ?? []))?.[0] ?? '')
        .find(text => text.includes(taskId));
      if (found) { settledFact = found; break; }
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    // review can only have started if main acted on that wake: the test sends nothing.
    let reviewStatus = '';
    const reviewDeadline = Date.now() + (settledFact ? 90_000 : 0);
    while (Date.now() < reviewDeadline) {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      reviewStatus = nodes.find(node => node.id === 'review')?.status ?? '';
      if (reviewStatus === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
    const lines = (Array.isArray(events.body) ? events.body : []).slice(-40)
      .map((event: { cursor?: number; type?: string; data?: unknown }) =>
        `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 200)}`);
    const masterWakes = provider.requests.filter(entry => entry.master)
      .map(entry => JSON.stringify([...(entry.body.messages ?? [])].reverse().find(message => message.role === 'user')?.content ?? '').slice(0, 160));
    const context = `settledFact: ${settledFact || '(none)'}\nreview: ${reviewStatus || '(missing)'}\nmaster wakes: ${masterWakes.join(' | ')}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`;
    expect(settledFact, context).toContain(`Node work in graph ${taskId} settled (succeeded)`);
    expect(reviewStatus, context).toBe('succeeded');

    // One wake per settled node: a replayed settlement must not wake main twice.
    // The ledger row belongs to the conversation's anchor task (the wake's
    // receiver), and its dedupe key names the graph task and the node.
    const ledger = new DatabaseSync(join(root, 'state/tasks.sqlite'), { readOnly: true });
    try {
      const rows = ledger.prepare("SELECT dedupe_key FROM wake_intents WHERE kind='node_settled'").all() as { dedupe_key: string }[];
      expect(rows).toHaveLength(2);
      expect(rows.filter(row => row.dedupe_key.startsWith(`${taskId}:work:`))).toHaveLength(1);
      expect(rows.filter(row => row.dedupe_key.startsWith(`${taskId}:review:`))).toHaveLength(1);
    } finally { ledger.close(); }
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
