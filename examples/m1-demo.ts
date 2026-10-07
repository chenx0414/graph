import { spawnSync } from 'node:child_process';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTaskRuntime } from '../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../src/core/interface-spec.ts';

// Two real Node hosts reopen one native graph. Pi uses deterministic local HTTP
// responses; this demonstrates execution and persistence, not autonomous coding.
if (process.argv[2] !== '--stage') {
  const root = process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(), 'graph-m1-demo-'));
  await mkdir(root, { recursive: true });
  for (const stage of ['implement', 'verify']) {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--stage', stage, root], { stdio: 'inherit' });
    if (child.error) throw child.error;
    if (child.status !== 0) process.exit(child.status ?? 1);
  }
  console.log(`Persistent native graph and delivery report: ${root}`);
} else {
  const stage = process.argv[3];
  if (stage !== 'implement' && stage !== 'verify') throw new Error('Expected implement or verify stage');
  const root = await realpath(resolve(process.argv[4]!));
  const stateDir = join(root, 'state');
  const marker = join(root, 'native-demo.json');
  if (existsSync(join(stateDir, 'tasks.sqlite')) && !existsSync(marker)) {
    throw new Error('This directory contains an older demo. Use a fresh directory for Graph v2.');
  }
  if (stage === 'verify' && !existsSync(marker)) throw new Error('Run the implement stage first');
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  if (stage === 'implement' && !existsSync(join(workspace, 'check.mjs'))) await writeFile(join(workspace, 'check.mjs'), `
import { search } from './search.mjs';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const actual = search(['Graph Runtime', 'Bookmarks', 'Graph Notes'], 'GRAPH');
if (JSON.stringify(actual) !== JSON.stringify(['Graph Runtime', 'Graph Notes'])) throw new Error('Title search failed');
console.log(JSON.stringify({ actual, digest: createHash('sha256').update(readFileSync('search.mjs')).digest('hex') }));
`);
  const source = 'export const search = (titles, query) => titles.filter(title => title.toLowerCase().includes(query.toLowerCase()));\n';
  const replies = [
    { tool_calls: [{ index: 0, id: 'write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'search.mjs', content: source }) } }] },
    { tool_calls: [{ index: 0, id: 'submit', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { path: 'search.mjs' } } } }) } }] },
    { content: 'The title search implementation is ready.' },
  ];
  let requests = 0;
  const provider = createServer(async (request, response) => {
    for await (const _chunk of request) { /* drain the real Pi request */ }
    requests++;
    const delta = stage === 'implement' ? replies.shift() : undefined;
    if (!delta) { response.writeHead(500); response.end('Unexpected model request'); return; }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ id: 'demo', object: 'chat.completion.chunk', created: 1, model: 'local-demo', choices: [{ index: 0, delta: { role: 'assistant', ...delta }, finish_reason: null }] })}\n\n`);
    // Deliberately omit usage: synthetic replies are not actual model token evidence.
    response.write(`data: ${JSON.stringify({ id: 'demo', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => provider.listen(0, '127.0.0.1', resolve));
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Local provider did not bind');
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
    modelRuntime.registerProvider('graph-openai', { baseUrl, api: 'openai-completions', apiKey: 'local-demo', models: [{
      id: 'local-demo', name: 'Deterministic local demo', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2048,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    }] });
    runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'demo', root: workspace }], models: {
      apiKey: 'local-demo', modelRuntime, entries: [{ id: 'local-demo', provider: 'graph-openai', grade: 'medium', api: 'openai-completions',
        baseUrl, contextWindow: 32000, maxTokens: 2048 }],
    } });
    runtime.catalog.publishDefinition('demo-coder', { recommendedGrade: 'medium' }, 'demo-coder');
    const { taskId: ownerId } = await runtime.user.begin({ projectId: 'demo', request: 'Demonstrate native title search execution', requestId: 'demo-begin' });
    const main = runtime.supervisor(ownerId);
    const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Persistent title search',
      protocols: { start: { type: 'object' }, artifact: { type: 'object', required: ['path'], properties: { path: { const: 'search.mjs' } } }, result: { type: 'object' } },
      nodes: { implement: { recipe: 'demo-coder@1', model: 'local-demo', task: 'Implement case-insensitive title search in search.mjs, then submit result with its path.',
        inputs: { job: { protocol: 'start' } }, outputs: { result: { protocol: 'artifact' } }, submission: { required: ['result'] }, budget: { tokens: null } } },
      modules: { verify: { type: 'operation', trigger: 'once', requiredInputs: ['job'], inputs: { job: { protocol: 'artifact' } }, outputs: { result: { protocol: 'result' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.mjs'], output: 'result' } } },
      edges: {}, outputs: { implementation: { from: 'implement.result', protocol: 'artifact' }, checked: { from: 'verify.result', protocol: 'result' } },
      acceptance: [{ id: 'title-search', description: 'Case-insensitive title search returns exactly the two matching titles', kind: 'check', module: 'verify' }],
    });
    const { graphId } = await main.graphCreate({ definition, requestId: 'demo-graph' }) as { graphId: string };
    if (existsSync(marker)) {
      const previous = JSON.parse(await readFile(marker, 'utf8'));
      if (previous.schemaVersion !== 2 || previous.graphId !== graphId || previous.ownerId !== ownerId) throw new Error('Native demo identity does not match');
    } else await writeFile(marker, JSON.stringify({ schemaVersion: 2, graphId, ownerId }));
    const task = runtime.user.task(graphId);
    if (stage === 'implement' && !(await task.view()).nodes.some(node => node.id === 'implement' && node.status === 'succeeded')) {
      await main.graphSend({ graphId, nodeId: 'implement', input: 'job', value: {} });
      await runtime.host.drive();
    }
    const handoffs = await main.graphInspect({ graphId, query: 'results' }) as { output_name: string; value: { path: string } }[];
    const handoff = handoffs.find(item => item.output_name === 'implementation');
    if (!handoff || handoff.value.path !== 'search.mjs') throw new Error(`Missing persisted implementation result: ${JSON.stringify(await main.graphInspect({ graphId, query: 'queue' }))}`);
    if (stage === 'verify' && (await task.view()).phase !== 'completed') {
      await main.graphSend({ graphId, nodeId: 'verify', input: 'job', value: handoff.value });
      await runtime.host.drive();
      await main.graphControl({ graphId, action: 'complete' });
      await runtime.host.drive();
    }
    const view = await task.view();
    const acceptance = await main.graphInspect({ graphId, query: 'acceptance' });
    const results = await main.graphInspect({ graphId, query: 'results' });
    await writeFile(join(root, 'delivery.json'), JSON.stringify({ schemaVersion: 2, view, acceptance, results }, null, 2));
    console.log(JSON.stringify({ stage, pid: process.pid, graphId, phase: view.phase, instanceId: view.nodes[0]!.instanceId, modelRequests: requests, used: view.nodes[0]!.used }));
    if (stage === 'verify' && view.phase !== 'completed') throw new Error('Native delivery did not complete');
  } finally {
    try { await runtime?.close(); }
    finally { provider.closeAllConnections(); await new Promise<void>((resolve, reject) => provider.close(error => error ? reject(error) : resolve())); }
  }
}
