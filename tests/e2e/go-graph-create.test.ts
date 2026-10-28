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
 * A real Git preparation failure resumes the same creation request after
 * repair without minting a second graph.
 *
 * Creating a graph on a branch that does not exist yet is not a lost
 * request: the graph is created, it waits, and an inspected retry prepares
 * that very graph once the branch is there. A request id that is reused for
 * different content is refused instead of quietly creating a second graph.
 *
 * The proof is a real daemon, a real repository and a real master Agent: the
 * Agent creates the graph with its own graph tool, exactly as the console
 * drives it.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

const run = promisify(execFile);

const DEFINITION = {
  schemaVersion: 2,
  name: 'Recover creation',
  protocols: {}, nodes: {}, modules: {}, edges: {}, inputs: {}, outputs: {},
};

const OTHER_DEFINITION = { ...DEFINITION, name: 'Different content' };

interface MasterCall { id: string; name: string; args: unknown; until?: (results: Map<string, string>) => boolean }

/** The master Agent: it plays the plan in order and records what every tool call answered. */
async function masterProvider(plan: (graphId: string) => MasterCall[]) {
  const results = new Map<string, string>();
  const requests: ChatBody[] = [];
  const served = new Map<string, string>();
  const repeats = new Map<string, number>();
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? '';
      if (base) results.set(base, content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan(graphId).find(call => !spoken.has(call.id) || (call.until && !call.until(results)));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The graph is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const repeat = repeats.get(next.id) ?? 0;
    const id = repeat === 0 ? next.id : `${next.id}-${repeat}`;
    served.set(id, next.id);
    if (next.until && !next.until(results)) repeats.set(next.id, repeat + 1);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    graphId: () => graphId,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a real Git preparation failure resumes the same creation request after repair without minting a second graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-graph-create-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The project is a repository whose target branch does not exist yet.
  await writeFile(join(project, 'README.md'), 'PREPARATION_BASELINE\n');
  for (const args of [['init', '-q', '-b', 'other'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    // A failing git command rejects here: the repository must be real.
    await run('git', args, { cwd: project });
  }

  const master = await masterProvider((graphId) => [
    { id: 'create-once', name: 'graph_create', args: { requestId: 'create-once', targetBranch: 'main', definition: DEFINITION } },
    { id: 'create-repair', name: 'graph_create', args: { requestId: 'create-once', targetBranch: 'main', definition: DEFINITION },
      until: results => /"replayed"\s*:\s*true/.test(results.get('create-repair') ?? '') },
    { id: 'create-conflict', name: 'graph_create', args: { requestId: 'create-once', targetBranch: 'main', definition: OTHER_DEFINITION } },
    { id: 'inspect-graph', name: 'graph_inspect', args: { graphId } },
    { id: 'inspect-queue', name: 'graph_inspect', args: { graphId, query: 'queue' } },
  ]);

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_CREATE_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
        baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_CREATE_KEY: 'create-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
    };

    const created = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Create a graph on a branch.', requestId: 'graph-create' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    // The branch does not exist, so the preparation fails and the graph waits.
    await expect.poll(() => master.results.get('create-once'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const blocked = JSON.parse(master.results.get('create-once')!) as { graphId: string; state: string; reason: string };
    expect(blocked).toMatchObject({ state: 'blocked' });
    expect(blocked.reason).toMatch(/branch|main|ref/i);
    expect(blocked.graphId).toBeTruthy();
    const graphId = blocked.graphId;
    const waiting = await request(`/api/tasks/${graphId}`);
    expect((waiting.body as { paused: boolean }).paused).toBe(true);

    await expect.poll(() => master.results.get('create-repair'), { timeout: 60_000, interval: 250 }).toContain('blocked');
    // The branch is there now. A checked retry prepares the same graph.
    await run('git', ['branch', 'main'], { cwd: project });
    const retry = await request(`/api/tasks/${graphId}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'retry_preparation', proof: 'The missing branch now exists and the failed Git process has exited.' }),
    });
    expect(retry.status, JSON.stringify(retry.body)).toBe(200);
    await expect.poll(() => /"replayed"\s*:\s*true/.test(master.results.get('create-repair') ?? ''), { timeout: 60_000, interval: 250 }).toBe(true);
    const repaired = JSON.parse(master.results.get('create-repair')!) as { graphId: string; replayed: boolean };
    expect(repaired).toMatchObject({ graphId, replayed: true });
    const prepared = await request(`/api/tasks/${graphId}`);
    expect((prepared.body as { paused: boolean }).paused).toBe(false);

    // The same request id with different content is refused, and the graph
    // that is already there does not change.
    await expect.poll(() => master.results.get('create-conflict'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const conflict = master.results.get('create-conflict')!;
    // The refusal reaches the model with the reason in it: a tool that says
    // no has to say why.
    expect(conflict).toContain('Creation requestId was already used with a different definition');
    // A refused creation mints no graph at all.
    expect(conflict).not.toMatch(/"graphId"/);
    await expect.poll(() => master.results.get('inspect-graph'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const summary = JSON.parse(master.results.get('inspect-graph')!) as { graphId: string; phase: string; revision: number; name: string };
    expect(summary.graphId).toBe(graphId);
    expect(summary.name).toBe('Recover creation');
    await expect.poll(() => master.results.get('inspect-queue'), { timeout: 60_000, interval: 250 }).toBeTruthy();
    const queue = JSON.parse(master.results.get('inspect-queue')!) as { items: unknown[] };
    expect(queue.items).toEqual([]);

    // The graph the request already owns is the one that is there, and it is
    // the only graph: the refused request minted no second one.
    const tasks = await request('/api/tasks');
    expect(tasks.status, JSON.stringify(tasks.body)).toBe(200);
    const listed = (tasks.body as { id: string }[]).map(task => task.id);
    expect(listed).toEqual([graphId]);
    const unchanged = await request(`/api/tasks/${graphId}`);
    expect((unchanged.body as { paused: boolean }).paused).toBe(false);

    // The graph can be stopped like any other.
    const stopped = await request(`/api/tasks/${graphId}/graph/control`, {
      method: 'POST', body: JSON.stringify({ action: 'stop' }),
    });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
