import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { DEFINITION, PROPOSAL, masterProvider, run } from './go-graph-confirmation.fixture.ts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object, got ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: unknown, key: string): string {
  const field = object(value)[key];
  if (typeof field !== 'string' || !field) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return field;
}

function integerField(value: unknown, key: string): number {
  const field = object(value)[key];
  if (typeof field !== 'number' || !Number.isInteger(field)) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return field;
}

async function heldProvider() {
  let requests = 0;
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
    const body = object(payload);
    if (!Array.isArray(body.tools) || body.tools.length === 0) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    requests += 1;
    await hold;
    if (response.destroyed) return;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
      index: 0, id: 'submit', type: 'function', function: {
        name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 42 } } } }),
      },
    }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 40, completion_tokens: 10 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Provider did not bind a TCP port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    count: () => requests,
    release,
    close: async () => {
      release();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function waitFor(condition: () => boolean, label: string) {
  await expect.poll(condition, { timeout: 20_000, interval: 100, message: label }).toBe(true);
}

test('two separately confirmed graphs execute at the same time', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-confirmed-concurrency-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), '# concurrent graphs\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    await run('git', args, { cwd: project });
  }

  const first = await heldProvider();
  const second = await heldProvider();
  const confirmed: string[] = [];
  const definition = (model: string) => ({
    ...DEFINITION,
    nodes: {
      a: { ...DEFINITION.nodes.a, model },
      b: { ...DEFINITION.nodes.b, model },
    },
  });
  const master = await masterProvider(() => [
    { id: 'proposal-1', name: 'propose_graph', args: {
      requestId: 'proposal-1', proposal: { ...PROPOSAL, definition: definition('worker-one') },
    } },
    { id: 'send-1', name: 'graph_send',
      args: () => ({ graphId: confirmed[0] ?? '', nodeId: 'a', input: 'in', value: { n: 1 } }),
      before: () => waitFor(() => confirmed.length >= 1, 'The first graph was not confirmed') },
    { id: 'proposal-2', name: 'propose_graph', args: {
      requestId: 'proposal-2', proposal: { ...PROPOSAL, requirementVersion: 2, definition: definition('worker-two') },
    } },
    { id: 'send-2', name: 'graph_send',
      args: () => ({ graphId: confirmed[1] ?? '', nodeId: 'a', input: 'in', value: { n: 2 } }),
      before: () => waitFor(() => confirmed.length >= 2, 'The second graph was not confirmed') },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const common = { api: 'openai-completions', grade: 'medium', maxTokens: 256,
      credentialId: 'concurrency', contextWindow: 32000 };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { concurrency: { secretRef: 'GRAPH_CONCURRENCY_KEY' } },
      models: { entries: [
        { ...common, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl },
        { ...common, id: 'worker-one', provider: 'graph-worker-one', modelId: 'one', baseUrl: first.baseUrl },
        { ...common, id: 'worker-two', provider: 'graph-worker-two', modelId: 'two', baseUrl: second.baseUrl },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_CONCURRENCY_KEY: 'concurrency-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, body: object) => {
      if (!daemon) throw new Error('Daemon is unavailable');
      const response = await daemon.request(path, { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return value;
    };
    const conversation = await request('/api/conversations', {
      projectId: 'p', model: 'main', text: 'Plan two independent tasks.', requestId: 'conversation',
    });
    const conversationId = stringField(conversation, 'conversationId');
    await waitFor(() => master.results.has('proposal-1'), 'The first proposal did not arrive');
    const firstProposalText = master.results.get('proposal-1');
    if (!firstProposalText) throw new Error('The first proposal has no receipt');
    const firstProposal: unknown = JSON.parse(firstProposalText);
    const graphOne = await request(`/api/conversations/${conversationId}/confirm`, {
      proposalVersion: integerField(firstProposal, 'proposalVersion'),
      draftRevision: integerField(firstProposal, 'draftRevision'), targetBranch: 'main', requestId: 'confirm-one',
    });
    confirmed.push(stringField(graphOne, 'taskId'));
    await waitFor(() => first.count() > 0, 'The first graph never reached its provider');
    await waitFor(() => master.results.has('proposal-2'), 'The second proposal did not arrive');
    const secondProposalText = master.results.get('proposal-2');
    if (!secondProposalText) throw new Error('The second proposal has no receipt');
    const secondProposal: unknown = JSON.parse(secondProposalText);
    const graphTwo = await request(`/api/conversations/${conversationId}/confirm`, {
      proposalVersion: integerField(secondProposal, 'proposalVersion'),
      draftRevision: integerField(secondProposal, 'draftRevision'), targetBranch: 'main', requestId: 'confirm-two',
    });
    confirmed.push(stringField(graphTwo, 'taskId'));
    expect(confirmed[1]).not.toBe(confirmed[0]);
    await waitFor(() => master.results.has('send-2'), 'The second graph did not receive its input');
    const sendText = master.results.get('send-2');
    if (!sendText) throw new Error('The second graph input has no receipt');
    const sendReceipt: unknown = JSON.parse(sendText);
    expect(object(object(sendReceipt).queue)).toMatchObject({ state: 'queued' });
    await waitFor(() => second.count() > 0, 'The second graph did not run while the first was held');
    expect(first.count()).toBeGreaterThan(0);
    expect(master.failures).toEqual([]);
  } finally {
    first.release();
    second.release();
    await daemon?.close();
    await master.close();
    await first.close();
    await second.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
