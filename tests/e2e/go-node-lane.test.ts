import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The node lane is where the work actually happens.
 *
 * A node runs on its own work copy - never on the user's project - it is
 * told which checks its work has to pass, and what it wrote stays in its own
 * tree. Those are what make a graph's work trustworthy, and none of them is
 * visible from the master side.
 *
 * The proof is a real daemon, a real graph and a real worker: the file the
 * worker wrote is in the worker's own tree and not in the project, and the
 * check command and the acceptance reach the worker while the rest of the
 * graph does not.
 */

const run = promisify(execFile);
const git = async (cwd: string, args: string[]) => {
  const result = await run('git', args, { cwd });
  return result.stdout;
};

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface Step { id: string; name: string; args: unknown; before?: () => Promise<void> }

/**
 * A scripted model. It plays the plan in order and records what every tool
 * call answered, so the test reads the graph the way the model read it.
 *
 * A request without tools is not the model speaking - it is the composer
 * asking for a suggested next message - and it is answered with plain text
 * so that it never eats a step of the plan.
 */
async function scriptedProvider(plan: () => Step[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const requests: unknown[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
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
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The work is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    await next.before?.();
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('a worker writes only its own work copy and is told the checks its work must pass', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-node-lane-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'project\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await git(project, args);
  }

  const definition = {
    schemaVersion: 2,
    name: 'Node lane',
    protocols: { data: { type: 'object' }, unrelated: { type: 'string', description: 'UNRELATED-PROTOCOL-MARKER' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'sender', task: 'Implement the request', acceptance: ['Read assigned checks'], inputs: {}, outputs: {}, submission: {} },
    },
    modules: {
      check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--test', 'test/specific.test.js'], output: 'result' } },
    },
    edges: {},
    acceptance: [{ id: 'ok', description: 'Specific command is successful', kind: 'check', module: 'check' }],
  };

  const worker = await scriptedProvider(() => [
    { id: 'write', name: 'write_file', args: { path: 'feature.txt', content: 'done' } },
  ]);
  const graphs: string[] = [];
  const master = await scriptedProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition, targetBranch: 'main' } },
      { id: 'chat', name: 'graph_send', args: { graphId, nodeId: 'work', text: 'Implement the request' } },
      { id: 'nodes', name: 'graph_inspect', args: { graphId, query: 'nodes' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

  const configPath = join(root, 'graph.config.json');
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'lane' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { lane: { secretRef: 'GRAPH_LANE_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...credential, id: 'sender', provider: 'graph-worker', modelId: 'worker-model', baseUrl: worker.baseUrl, contextWindow: 32000 },
    ] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_LANE_KEY: 'lane-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Do the work.', requestId: 'node-lane' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('nodes'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    // The node really ran.
    await expect.poll(async () => {
      const view = await (await daemon.request(`/api/tasks/${graphs[0]}`)).json() as { nodes: { id: string; status: string }[] };
      return view.nodes.find(node => node.id === 'work')?.status;
    }, { timeout: 120_000, interval: 250 }).toBe('succeeded');

    // The worker was told which check its work has to pass.
    const workerRequest = worker.requests.find(request => JSON.stringify(request).includes('test/specific.test.js'));
    expect(workerRequest, 'the worker never received its prompt').toBeTruthy();
    const prompt = JSON.stringify(workerRequest);
    expect(prompt).toContain('Specific command is successful');
    expect(prompt).toContain('Read assigned checks');
    // The rest of the graph is not the worker's business.
    expect(prompt).not.toContain('UNRELATED-PROTOCOL-MARKER');

    // The file the worker wrote is in the worker's own tree, not in the project.
    const view = await (await daemon.request(`/api/tasks/${graphs[0]}`)).json() as {
      worktrees: { nodeId: string; path: string }[];
    };
    const tree = view.worktrees.find(item => item.nodeId === 'work')?.path ?? '';
    expect(tree).not.toBe(project);
    expect(tree).not.toBe('');
    expect(await readFile(join(tree, 'feature.txt'), 'utf8')).toBe('done');
    expect(existsSync(join(project, 'feature.txt'))).toBe(false);
  } finally {
    await daemon.close();
    await master.close();
    await worker.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);

test('a reviewer is told what to publish and its report really satisfies the review', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-review-node-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'project\n');

  const definition = {
    schemaVersion: 2,
    name: 'Independent review',
    protocols: { data: { type: 'object' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'sender', task: 'Produce a non-code result', inputs: {}, outputs: { result: { protocol: 'data' } }, submission: {} },
      review: { recipe: 'reviewer@1', model: 'reader', task: 'Inspect the result independently', inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {} },
    },
    modules: {},
    edges: { review: { from: 'work.result', to: 'review.job', enabled: true } },
    acceptance: [{ id: 'reviewed', description: 'Independent review passes', kind: 'review', node: 'review' }],
  };

  const reviewer = await scriptedProvider(() => [
    { id: 'report', name: 'artifact_publish', args: {
      namespace: 'reviews', name: 'review', schema: 'graph.review@1', mediaType: 'application/json',
      requestId: 'review-report', content: JSON.stringify({ commit: null, passed: true, reason: 'Independently inspected the non-code result.' }),
    } },
  ]);
  const graphs: string[] = [];
  const master = await scriptedProvider(() => {
    const graphId = graphs[0] ?? '';
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'review-job', name: 'graph_send', args: { graphId, nodeId: 'review', input: 'job', value: { text: 'Review the assigned result' } } },
      { id: 'acceptance', name: 'graph_inspect', args: { graphId, query: 'acceptance' },
        before: async () => {
          // The reviewer really finished before the acceptance is read.
          for (let attempt = 0; attempt < 400; attempt += 1) {
            const view = await (await daemon.request(`/api/tasks/${graphs[0]}`)).json() as { nodes: { id: string; status: string }[] };
            if (view.nodes.find(node => node.id === 'review')?.status === 'succeeded') return;
            await new Promise(resolve => setTimeout(resolve, 200));
          }
          throw new Error('the reviewer never finished');
        } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });

  const configPath = join(root, 'graph.config.json');
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'lane' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { lane: { secretRef: 'GRAPH_LANE_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      { ...credential, id: 'sender', provider: 'graph-worker', modelId: 'worker-model', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000 },
      { ...credential, id: 'reader', provider: 'graph-reviewer', modelId: 'reviewer-model', baseUrl: reviewer.baseUrl, contextWindow: 32000 },
    ] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_LANE_KEY: 'lane-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Have the result reviewed.', requestId: 'review-node' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('acceptance'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    // The reviewer was told what to publish.
    const reviewerRequest = reviewer.requests.find(request => JSON.stringify(request).includes('FINAL REVIEW REQUIREMENTS'));
    expect(reviewerRequest, 'the reviewer never received its requirements').toBeTruthy();
    const prompt = JSON.stringify(reviewerRequest);
    expect(prompt).toContain('graph.review@1');
    expect(prompt).toContain('commit,passed,reason');

    // The report it published really satisfied the review.
    const acceptance = JSON.parse(master.results.get('acceptance')!) as { ready: boolean; items: { id: string; status: string }[] };
    expect(acceptance).toMatchObject({ ready: true, items: [{ id: 'reviewed', status: 'passed' }] });
  } finally {
    await daemon.close();
    await master.close();
    await reviewer.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
