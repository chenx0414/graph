// Follow-up diagnostics for the third-round capability gaps. Run from the Graph repository root.
// Prints observed behavior; exit code 0 is not a product acceptance verdict.
import { existsSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTaskRuntime } from '../../../src/core/task-runtime.ts';
import { createRetrievalBroker } from '../../../src/runtime/retrieval.ts';
import { openaiServer } from '../../../tests/fixtures/openai-server.ts';

const extensionFixture = fileURLToPath(new URL('../../../tests/fixtures/extension-capability.mjs', import.meta.url));
const root = await mkdtemp(join(tmpdir(), 'graph-capabilities-'));
const workspace = join(root, 'project');
await mkdir(workspace);
const outside = join(root, 'outside.txt');
await writeFile(outside, 'formal');

const extension = join(root, 'extension');
await mkdir(extension);
await copyFile(extensionFixture, join(extension, 'extension.mjs'));
await writeFile(join(extension, 'capability.json'), JSON.stringify({ kind: 'extension', entry: './extension.mjs' }));
const remote = join(root, 'remote');
await mkdir(remote);

let mcpCalls = 0;
const hits: string[] = [];
const server = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk);
  hits.push(req.url ?? '');
  if (req.url === '/text') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('retrieval body');
    return;
  }
  const request = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number; method?: string; params?: { arguments?: { text?: string } } };
  if (request.method === 'notifications/initialized') { res.writeHead(202); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json', ...(request.method === 'initialize' ? { 'mcp-session-id': 'session-1' } : {}) });
  if (request.method === 'initialize') res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'remote-fixture', version: '1.0.0' } } }));
  else if (request.method === 'tools/list') res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'echo', description: 'Echo text', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] } }));
  else if (request.method === 'tools/call') { mcpCalls += 1; res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: `remote:${request.params?.arguments?.text ?? ''}` }], isError: false } })); }
  else res.end(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'unknown method' } }));
});
await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as { port: number }).port;
const base = `http://127.0.0.1:${port}`;
await writeFile(join(remote, 'capability.json'), JSON.stringify({ kind: 'mcp', transport: 'http', url: `${base}/mcp` }));

const provider = await openaiServer([
  { tools: [
    { id: 'e1', name: 'mcp_ext_write_proof', arguments: JSON.stringify({ outside }) },
    { id: 'm1', name: 'mcp_remote_echo', arguments: JSON.stringify({ text: 'hello' }) },
    { id: 'f1', name: 'fetch', arguments: JSON.stringify({ url: `${base}/text` }) },
  ] },
  { text: 'Called the extension, remote MCP, and retrieval.' },
]);
const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
  network: { retrievalDomains: ['127.0.0.1'], mcpDomains: ['127.0.0.1'] },
  models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
  actions: { check: { kind: 'program', prepare: async () => async () => ({
    outcome: 'completed', output: null,
    evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }],
  }) } },
});
try {
  runtime.catalog.publishDefinition('coder', { recommendedGrade: 'high', capabilities: [{ id: 'ext', version: '1.0.0' }, { id: 'remote', version: '1.0.0' }] }, 'coder');
  await runtime.catalog.install({ id: 'ext', kind: 'extension', source: extension, version: '1.0.0', requestId: 'install-ext' });
  await runtime.catalog.install({ id: 'remote', kind: 'mcp', source: remote, version: '1.0.0', requestId: 'install-remote' });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Use the bound capabilities.', requestId: 'begin' });
  const proposed = await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'Use the bound capabilities',
    acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
    ],
  }, 'proposal');
  const task = runtime.user.task(taskId);
  await task.accept({ proposalVersion: proposed.proposalVersion, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const view = await task.view();
  const answer = JSON.stringify(provider.requests[1]);
  console.log(JSON.stringify({
    name: 'granted-capabilities-callable',
    extensionWrote: existsSync(join(workspace, 'extension-capability.txt')),
    outsideUnchanged: readFileSync(outside, 'utf8') === 'formal',
    extensionOutsideDenied: answer.includes('outsideDenied'),
    remoteMcpCalls: mcpCalls,
    remoteMcpAnswered: answer.includes('remote:hello'),
    retrievalAnswered: answer.includes('retrieval body'),
    questions: view.questions.map(question => question.kind),
    zeroUsageInvocations: view.invocations.filter(row => row.usage && row.usage.input === 0 && row.usage.output === 0 && row.usage.cacheRead === 0).length,
  }));
  const denied = createRetrievalBroker({ domains: ['example.com'], gate: { dispatch: (_id, _reservation, send) => send(), settle: () => {} } });
  let deniedMessage = '';
  try { await denied.fetch(`${base}/text`); }
  catch (error) { deniedMessage = String(error); }
  console.log(JSON.stringify({ name: 'retrieval-domain-denied', denied: deniedMessage.includes('not in the granted retrieval domains'), serverHits: hits.length }));
} finally {
  await runtime.close();
  await provider.close();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
