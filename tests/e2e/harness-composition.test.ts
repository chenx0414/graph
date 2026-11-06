import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ProviderBody {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: unknown; tool_call_id?: string }[];
}

function sse(response: import('node:http').ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 90, completion_tokens: 25 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

async function fixture(prefix: string, workerUrl: string, mainUrl: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-e2e-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: mainUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' },
      { id: 'worker', provider: 'graph-worker', grade: 'medium', api: 'openai-completions', baseUrl: workerUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' },
    ] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-composition-key' } });
  cleanup.push(() => daemon.close());
  return { root, daemon };
}

test('a second probe starts from the harness the project already adopted', async () => {
  const workerRequests: ProviderBody[] = [];
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    workerRequests.push(body);
    const text = JSON.stringify(body);
    const marker = text.includes('Z_TEXT') ? 'Z_TEXT' : text.includes('X_TEXT') ? 'X_TEXT' : 'Y_TEXT';
    const steps = workerRequests.filter(seen => JSON.stringify(seen).includes(marker)).length;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (steps === 1) calls = [{ id: `list-${marker}`, name: 'list_dir', args: { path: '.' } }];
    if (steps === 2) calls = [{ id: `submit-${marker}`, name: 'submit', args: { outputs: { out: { enable: true, value: { ok: true, lane: marker } } } } }];
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: 'Candidate finished.' }, 'stop');
  });

  const results = new Map<string, string>();
  let step = 0;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'probe_harness') ?? false;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (isMain) {
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          results.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        }
      }
      const tools = body.messages.filter(message => message.role === 'tool');
      const last = tools.length ? tools[tools.length - 1]!.content : '';
      const lastText = typeof last === 'string' ? last : JSON.stringify(last);
      const graphId = /"graphId"\s*:\s*"([0-9a-f-]{36})"/.exec(lastText)?.[1] ?? '';
      switch (step) {
        case 0:
          calls = [{ id: 'probe-one', name: 'probe_harness', args: {
            task: 'PARSE_THE_DOCUMENT', recipe: 'coder@1', model: 'worker', domain: 'parser',
            variants: [
              { label: 'alpha', harness: { 'rules/worker.md': 'X_TEXT', 'tools/worker.md': 'X_TOOLS' } },
              { label: 'beta', harness: { 'rules/worker.md': 'Y_TEXT' } },
            ],
          } }];
          break;
        case 1:
          calls = [{ id: 'adopt', name: 'record_harness_decision', args: {
            graphId, domain: 'parser', axis: 'specific', chosen: 'A',
            cue: 'The rules alone were not enough.',
            lesson: 'Also adjust the tool guidance.',
            evidence: 'The alpha candidate did the extra step.',
          } }];
          break;
        case 2:
          calls = [{ id: 'probe-two', name: 'probe_harness', args: {
            task: 'PARSE_THE_DOCUMENT', recipe: 'coder@1', model: 'worker', domain: 'parser',
            baseHarness: 'adopted',
            variants: [
              { label: 'base', harness: {} },
              { label: 'alpha', harness: { 'rules/worker.md': 'Z_TEXT' } },
            ],
          } }];
          break;
      }
      step++;
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Rounds done.' : 'No suggestion' }, 'stop');
  });

  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve())); });
  const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1`;
  await new Promise<void>(resolve => main.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { main.closeAllConnections(); await new Promise<void>(resolve => main.close(() => resolve())); });
  const mainUrl = `http://127.0.0.1:${(main.address() as AddressInfo).port}/v1`;

  const { daemon } = await fixture('harness-composition', workerUrl, mainUrl);

  // The main agent talks to the same fake provider, so the config points at it.
  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Run two rounds of probes', requestId: 'harness-composition' }),
  });
  expect(created.status).toBe(200);

  const deadline = Date.now() + 120000;
  while (!results.get('probe-two') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));

  // The adopted lesson keeps the harness it was adopted from.
  // The write answers with the record it wrote: the lesson keeps the harness it
  // was adopted from, and the reply no longer echoes the whole scope.
  const decision = JSON.parse(results.get('adopt') || '{}') as { entry?: { chosen: string; overlay: Record<string, string> }; entries?: unknown };
  expect(decision.entry, 'the write does not name the record it wrote').toBeTruthy();
  expect(decision.entry!.chosen).toBe('alpha');
  expect(decision.entry!.overlay['rules/worker.md']).toBe('X_TEXT');
  expect(decision.entry!.overlay['tools/worker.md']).toBe('X_TOOLS');
  expect(decision.entries, 'the write still echoes the whole scope').toBeUndefined();

  // The second round starts from that harness and layers the new change on top.
  const second = JSON.parse(results.get('probe-two') || '{}') as {
    comparison: { candidates: { nodeId: string; harness: Record<string, string> }[] };
  };
  // The base candidate runs under the harness the project adopted; the other
  // runs under that harness with one more change on top.
  const base = second.comparison.candidates.find(candidate => candidate.nodeId === 'base')!;
  const changed = second.comparison.candidates.find(candidate => candidate.nodeId === 'alpha')!;
  expect(base.harness['rules/worker.md']).toBe('X_TEXT');
  expect(base.harness['tools/worker.md']).toBe('X_TOOLS');
  expect(changed.harness['rules/worker.md']).toBe('Z_TEXT');
  expect(changed.harness['tools/worker.md']).toBe('X_TOOLS');
}, 300_000);
