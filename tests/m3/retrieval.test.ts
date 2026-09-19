import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function entry(baseUrl: string) {
  return { id: 'local', provider: 'graph-openai' as const, grade: 'high' as const, api: 'openai-completions' as const, baseUrl, contextWindow: 32_000, maxTokens: 256 };
}

async function retrievalServer() {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    if (req.url === '/text') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('retrieval body');
      return;
    }
    if (req.url === '/binary') {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(Buffer.from([0, 1, 2, 3]));
      return;
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { location: 'http://example.com/' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('missing');
  });
  await new Promise<void>(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    hits,
    close: () => new Promise<void>((resolvePromise, reject) => { server.closeAllConnections(); server.close(error => error ? reject(error) : resolvePromise()); }),
  };
}

async function retrievalTask(plans: ResponsePlan[], network: { retrievalDomains?: string[]; unrestricted?: boolean } | undefined = { retrievalDomains: ['127.0.0.1'] }) {
  const root = await mkdtemp(join(tmpdir(), 'graph-retrieval-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace);
  const provider = await openaiServer(plans);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    network: network?.retrievalDomains ? { retrievalDomains: network.retrievalDomains } : {},
    ...(network?.unrestricted ? { access: () => fullAccessPolicy() } : {}),
    models: { entries: [entry(provider.model.baseUrl)], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    actions: { check: { kind: 'program', prepare: async () => async () => ({
      outcome: 'completed', output: null,
      evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
    }) } },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high' }, 'coder');
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Research the API.', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Research the API',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  return { runtime, provider, workspace, task };
}

function fetchPlan(url: string, text = 'Read the page.'): ResponsePlan[] {
  return [
    { tools: [{ id: 'f1', name: 'fetch', arguments: JSON.stringify({ url }) }] },
    { text },
  ];
}

test('a granted domain is fetched through the gated broker and metered', async () => {
  const server = await retrievalServer();
  cleanup.push(() => server.close());
  const { runtime, provider, task } = await retrievalTask(fetchPlan(`${server.base}/text`));
  await runtime.host.drive();
  const answer = JSON.stringify(provider.requests[1]);
  expect(answer).toContain('retrieval body');
  expect(answer).toContain('\\"status\\":200');
  const view = await task.view();
  expect(view.questions).toEqual([]);
  expect(view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0 && row.usage.cacheRead === 0 && row.usage.cacheWrite === 0).length).toBeGreaterThanOrEqual(1);
  expect(server.hits).toEqual(['/text']);
});

test('a host outside the granted domains is refused before any request', async () => {
  const { runtime, provider, task } = await retrievalTask(fetchPlan('http://example.com/page'));
  await runtime.host.drive();
  expect(JSON.stringify(provider.requests[1])).toContain('not in the granted retrieval domains');
  const view = await task.view();
  expect(view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0).length).toBe(0);
  expect(view.questions).toEqual([]);
});

test('non-textual content is refused instead of being returned', async () => {
  const server = await retrievalServer();
  cleanup.push(() => server.close());
  const { runtime, provider, task } = await retrievalTask(fetchPlan(`${server.base}/binary`));
  await runtime.host.drive();
  expect(JSON.stringify(provider.requests[1])).toContain('non-textual content type');
  expect((await task.view()).questions).toEqual([]);
});

test('a redirect to an ungranted host is refused', async () => {
  const server = await retrievalServer();
  cleanup.push(() => server.close());
  const { runtime, provider } = await retrievalTask(fetchPlan(`${server.base}/redirect`));
  await runtime.host.drive();
  expect(JSON.stringify(provider.requests[1])).toContain('Retrieval failed');
  expect(server.hits).toEqual(['/redirect']);
});

test('a paused task cannot start a retrieval request', async () => {
  const server = await retrievalServer();
  cleanup.push(() => server.close());
  let pause: (() => Promise<void>) | undefined;
  const plans = fetchPlan(`${server.base}/text`, 'Stopped by the pause.');
  plans[0]!.beforeReply = async () => { await pause?.(); };
  const { runtime, task } = await retrievalTask(plans);
  pause = async () => { await task.pause('pause'); };
  await runtime.host.drive();
  expect((await task.view()).paused).toBe(true);
  expect(server.hits).toEqual([]);
});

test('no retrieval tool is exposed without granted domains', async () => {
  const { runtime, provider } = await retrievalTask([{ text: 'Nothing to do.' }], {});
  await runtime.host.drive();
  expect(JSON.stringify(provider.requests[0])).not.toContain('"name":"fetch"');
});

test('full access exposes retrieval for any host while keeping redirect and content bounds', async () => {
  const server = await retrievalServer();
  cleanup.push(() => server.close());
  const { runtime, provider, task } = await retrievalTask(fetchPlan(`${server.base}/text`), { unrestricted: true });
  await runtime.host.drive();
  expect((await task.view()).questions).toEqual([]);
  expect(provider.requests).toHaveLength(2);
  expect(JSON.stringify(provider.requests[1])).toContain('retrieval body');
  expect(server.hits).toEqual(['/text']);
});
