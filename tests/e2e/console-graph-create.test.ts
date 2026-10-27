import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ProviderBody {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: unknown }[];
}

function sse(response: import('node:http').ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 60, completion_tokens: 20 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

/**
 * A console caller may start a graph without spending a model turn.
 *
 * `graph_create` is a main-Agent tool, so a caller that wants the work done by
 * a worker - an isolated evaluation, for one - had to ask the main Agent to
 * plan and propose the graph first, and the verdict then measured the planner
 * as much as the worker. This route is the same door without the planner: the
 * graph's owner is the conversation the caller names, which is exactly the
 * owner an Agent-created graph records.
 */
test('the console creates a graph from a definition on behalf of a conversation, and refuses one without an owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-console-create-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    sse(response, { role: 'assistant', content: 'Standing by.' }, 'stop');
    void body;
  });
  await new Promise<void>(resolve => main.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { main.closeAllConnections(); await new Promise<void>(resolve => main.close(() => resolve())); });
  const mainUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}/v1`;

  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    access: fullAccessPolicy(),
    credentials: { local: { secretRef: 'GRAPH_CONSOLE_CREATE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: mainUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_CONSOLE_CREATE_KEY: 'console-create-key' } });
  cleanup.push(() => daemon.close());

  const definition = {
    schemaVersion: 2,
    name: 'Console created',
    protocols: { job: { type: 'object' }, done: { type: 'object' } },
    nodes: {
      work: { recipe: 'coder@1', model: 'local', task: 'DO_THE_WORK', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
    },
    modules: {},
    edges: {},
    inputs: { start: { to: 'work.in', protocol: 'job' } },
    outputs: { done: { from: 'work.out', protocol: 'done' } },
  };

  // An owner is required, and it has to be a real conversation.
  const ownerless = await daemon.request('/api/graphs', { method: 'POST', body: JSON.stringify({ definition }) });
  expect(ownerless.status).toBe(400);
  expect(JSON.stringify(await ownerless.json().catch(() => ({})))).toMatch(/conversation/i);

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Stand by.', requestId: 'console-create-conversation' }),
  });
  expect(created.status).toBe(200);
  const conversationId = (await created.json() as { conversationId: string }).conversationId;
  expect(conversationId).toBeTruthy();

  const made = await daemon.request('/api/graphs', {
    method: 'POST',
    body: JSON.stringify({ conversationId, definition, targetBranch: 'main', requestId: 'console-create-graph' }),
  });
  expect(made.status, JSON.stringify(await made.clone().json().catch(() => ({})))).toBe(200);
  const receipt = await made.json() as { graphId?: string };
  expect(receipt.graphId, 'the route must answer with the graph it created').toBeTruthy();

  // The graph exists and carries the node the caller declared, unstarted: the
  // caller decides when work begins, exactly as with graph_create.
  const view = await daemon.request(`/api/tasks/${receipt.graphId}/graph`);
  expect(view.status).toBe(200);
  const graph = await view.json() as { nodes?: { id?: string; nodeId?: string }[] };
  const ids = (graph.nodes ?? []).map(node => node.id ?? node.nodeId ?? '');
  expect(ids).toContain('work');

  // The same request is a replay, not a second graph.
  const again = await daemon.request('/api/graphs', {
    method: 'POST',
    body: JSON.stringify({ conversationId, definition, targetBranch: 'main', requestId: 'console-create-graph' }),
  });
  expect(again.status).toBe(200);
  expect((await again.json() as { graphId?: string }).graphId).toBe(receipt.graphId);
}, 120000);
