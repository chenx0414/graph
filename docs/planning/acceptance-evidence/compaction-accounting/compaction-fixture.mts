// Reproducible K04 evidence: real Pi auto-compaction through the production
// Pi adapter, task gate and SQLite ledger. No paid provider is contacted.
// Run: ./node_modules/.bin/node docs/planning/acceptance-evidence/compaction-accounting/compaction-fixture.mts
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../../../../src/core/task-runtime.ts';
import { installPresets } from '../../../../src/catalog/presets.ts';

const LONG_TEXT = 'The worker keeps going. '.repeat(280);
const presetRoot = new URL('../../../../presets', import.meta.url).pathname;

async function provider() {
  const requests: { summary: boolean; tools: number; messages: number }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[]; messages?: unknown[] } : {};
    const tools = (body.tools ?? []) as unknown[];
    const summary = tools.length === 0;
    const index = requests.length;
    requests.push({ summary, tools: tools.length, messages: (body.messages ?? []).length });
    const usage = summary ? { prompt_tokens: 900, completion_tokens: 30 } : { prompt_tokens: 2_000, completion_tokens: 40 };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: summary ? '## Goal\ncompacted context' : LONG_TEXT }, null);
    chunk({}, 'stop');
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model<'openai-completions'> = {
    id: 'local', name: 'Local', provider: 'local', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 2_048, maxTokens: 256,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider('local', { baseUrl, api: 'openai-completions', apiKey: 'local-key', models: [model] });
  return { baseUrl, runtime, requests, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

const root = await mkdtemp(join(tmpdir(), 'graph-compaction-fixture-'));
const workspace = join(root, 'project');
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, 'check.js'), 'console.log("ok");\n');
const local = await provider();
const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
  actions: { check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }] }) } },
  models: {
    entries: [{ id: 'local', provider: 'local', grade: 'high', api: 'openai-completions', baseUrl: local.baseUrl, contextWindow: 2_048, maxTokens: 256, credentialId: 'c', cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
    apiKey: 'local-key', modelRuntime: local.runtime,
  },
});
await installPresets(runtime.catalog, presetRoot);
const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'K04 fixture', requestId: 'begin' });
await runtime.supervisor(taskId).propose({
  requirementVersion: 1, summary: 'K04 fixture',
  acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
  nodes: [
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
    { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
  ],
}, 'proposal');
await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
await runtime.host.runReady();

const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
const invocations = db.prepare('SELECT purpose,model,usage,cost FROM invocations ORDER BY rowid').all() as { purpose: string; model: string; usage: string | null; cost: string | null }[];
const instances = db.prepare('SELECT id,used FROM instances').all() as { id: string; used: number }[];
db.close();
const view = runtime.nodeRun(taskId, 'work');
const compactedEntries = view.entries.filter(entry => entry.kind === 'compaction');

console.log(JSON.stringify({
  fixture: 'worker auto-compaction (contextWindow 2048, maxTokens 256)',
  providerRequests: local.requests,
  providerRequestCount: local.requests.length,
  summaryRequestCount: local.requests.filter(request => request.summary).length,
  invocations: invocations.map(row => ({ purpose: row.purpose, model: row.model, usage: row.usage ? JSON.parse(row.usage) : null, cost: row.cost ? JSON.parse(row.cost) : null })),
  purposeList: invocations.map(row => row.purpose),
  instanceTotals: instances,
  invocationTokenTotal: invocations.reduce((sum, row) => sum + (row.usage ? Object.values(JSON.parse(row.usage) as Record<string, number>).reduce((inner, value) => inner + value, 0) : 0), 0),
  compactionEntries: compactedEntries.map(entry => ({ kind: entry.kind, role: entry.role, data: entry.data, textLength: entry.text.length })),
  originalEntriesKept: view.entries.filter(entry => entry.role === 'assistant' || entry.role === 'user').length,
  entryKinds: view.entries.map(entry => `${entry.role}:${entry.kind}`),
}, null, 2));

await runtime.close();
await local.close();
await rm(root, { recursive: true, force: true });
