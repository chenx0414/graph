import { createServer, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A model a running graph depends on cannot be taken away.
 *
 * The master proposes a graph whose node is pinned to one configured model.
 * The user confirms it, and the node waits for work with that model still
 * named. Removing that model from the configuration would leave the running
 * graph pointing at nothing, so the daemon refuses the change by name and
 * keeps the binding it already has - the node stays idle, it still names the
 * model it was declared with, and the configuration on disk does not move.
 *
 * Once the graph is stopped, nothing depends on that model any more, and the
 * very same change goes through.
 *
 * The proof is a real daemon, a real proposal from the master Agent, a real
 * confirmation over HTTP and a real configuration file.
 */

const run = promisify(execFile);

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall { id: string; name: string; args: unknown | (() => unknown) }

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call answered, so the test reads the graph the way the model read it.
 */
async function masterProvider(plan: () => MasterCall[]) {
  const results = new Map<string, string>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The graph is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const args = typeof next.args === 'function' ? next.args() : next.args;
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const DEFINITION = {
  schemaVersion: 2,
  name: 'keep binding',
  protocols: { data: { type: 'object' } },
  nodes: {
    work: {
      recipe: 'coder@1', model: 'local', task: 'Keep the declared model',
      inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {},
    },
  },
  modules: {},
  edges: {},
  acceptance: [{ id: 'works', description: 'The node keeps its model', kind: 'human' }],
};

const PROPOSAL = {
  requirementVersion: 1,
  summary: 'One node that keeps its model',
  acceptance: [{ id: 'works', description: 'The node keeps its model', checkNode: 'work' }],
  definition: DEFINITION,
};

test('a model a running graph depends on cannot be removed, and the daemon keeps the binding', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-model-binding-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# binding\n');
  let graphId = '';
  let inspectRevision = false;
  // The target branch is a real branch of a real repository.
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: project });
  }

  const master = await masterProvider(() => {
    // Before the graph exists the master proposes it; afterwards it reads the
    // revision back, which is where the declared model is visible.
    if (inspectRevision) return [{ id: 'revision', name: 'graph_inspect', args: { graphId, query: 'revision' } }];
    return [{ id: 'propose', name: 'propose_graph', args: { requestId: 'proposal-binding', proposal: PROPOSAL } }];
  });
  const configPath = join(root, 'graph.config.json');
  const entry = { provider: 'graph-master', api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'local', contextWindow: 32000 };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { ...entry, id: 'main', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl },
      { ...entry, id: 'local', modelId: 'local-model', baseUrl: master.baseUrl },
    ] },
  }));

  const daemon = await launchCli(root, { configPath, webDir: join(root, 'web'), env: { GRAPH_LOCAL_KEY: 'local-synthetic' }, extraArgs: ['--execute'] });
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { text }; }
    return { status: response.status, body: body as Record<string, unknown> };
  };
  const post = (path: string, body: unknown) => request(path, { method: 'POST', body: JSON.stringify(body) });

  try {
    // The master proposes a graph whose node is pinned to the model `local`.
    const started = await post('/api/conversations', {
      projectId: 'p', model: 'main', text: 'Make a one node graph.', requestId: 'model-binding',
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const conversationId = started.body.conversationId as string;

    await expect.poll(() => master.results.has('propose'), { timeout: 120_000, interval: 250 }).toBeTruthy();
    const receipt = JSON.parse(master.results.get('propose')!) as { proposalVersion: number; draftRevision: number };

    // The user confirms it; the confirmed graph is a task of its own.
    const accepted = await post(`/api/conversations/${conversationId}/confirm`, {
      proposalVersion: receipt.proposalVersion, draftRevision: receipt.draftRevision, targetBranch: 'main', requestId: 'confirm',
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    const taskId = accepted.body.taskId as string;
    graphId = taskId;

    // The node waits for work, and it names the model it was declared with.
    const view = await request(`/api/tasks/${taskId}`);
    expect(view.status, JSON.stringify(view.body)).toBe(200);
    const nodes = (view.body as { nodes?: { id: string; status: string; model?: string }[] }).nodes ?? [];
    expect(nodes.find(node => node.id === 'work')).toMatchObject({ status: 'idle' });

    // Taking the model away is refused by name.
    const withoutLocal = {
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl },
        { ...entry, id: 'replacement', modelId: 'replacement-model', baseUrl: master.baseUrl },
      ] },
    };
    const refused = await post('/api/config', { expectedRevision: 0, document: withoutLocal });
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(refused.body).toMatchObject({ code: 'config_in_use' });
    expect(String(refused.body.message)).toContain('local');

    // The daemon keeps the binding it already had, and the disk did not move.
    const kept = await request(`/api/tasks/${taskId}`);
    expect((kept.body as { nodes?: { id: string; status: string }[] }).nodes?.find(node => node.id === 'work'))
      .toMatchObject({ status: 'idle' });
    const config = await request('/api/config');
    expect(config.body.revision).toBe(0);
    expect(JSON.stringify(config.body)).toContain('"local"');

    // The graph still declares that model: the refused change did not rewrite it.
    inspectRevision = true;
    await post(`/api/conversations/${conversationId}/messages`, { text: 'Read the revision of that graph.', requestId: 'read-revision' });
    await expect.poll(() => master.results.has('revision'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const revision = JSON.parse(master.results.get('revision')!) as { nodes: { work: { model?: string } } };
    expect(revision.nodes.work.model).toBe('local');

    // Once the graph is stopped, nothing depends on that model any more.
    const stopped = await post(`/api/tasks/${taskId}/graph/control`, { action: 'stop' });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    const saved = await post('/api/config', { expectedRevision: 0, document: withoutLocal });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const after = await request('/api/config');
    expect(after.body.revision).toBe(1);
    const savedModels = (after.body as { config?: { models?: { entries?: { id: string }[] } } }).config?.models?.entries ?? [];
    expect(savedModels.map(entry => entry.id)).toEqual(['main', 'replacement']);
  } finally {
    await daemon.close();
    await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180_000);
