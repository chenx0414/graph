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
  messages: { role: string; content: unknown; tool_call_id?: string }[];
}

function sse(response: import('node:http').ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 110, completion_tokens: 30 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('one run reads its own evidence, probes two harnesses, keeps the lesson, and the next task starts with it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-loop-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  // The candidates of the probe differ only in the prompt text they run under.
  const workerRequests: ProviderBody[] = [];
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    workerRequests.push(body);
    const text = JSON.stringify(body);
    const marker = text.includes('GENERAL_RULE') ? 'GENERAL_RULE' : 'DOMAIN_RULE';
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
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve())); });
  const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1`;

  const prompts: { system: string; user: string }[] = [];
  const results = new Map<string, string>();
  let step = 0;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'compare_harness_candidates') ?? false;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (isMain) {
      const system = body.messages.find(message => message.role === 'system' || message.role === 'developer');
      const user = body.messages.find(message => message.role === 'user');
      prompts.push({
        system: typeof system?.content === 'string' ? system.content : JSON.stringify(system?.content ?? ''),
        user: typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? ''),
      });
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          results.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        }
      }
      switch (step) {
        case 0:
          // A tool call that fails: the file is not there.
          calls = [{ id: 'failed-read', name: 'read', args: { path: 'missing-report.txt' } }];
          break;
        case 1:
          calls = [{ id: 'evidence', name: 'read_harness_evidence', args: {} }];
          break;
        case 2:
          calls = [{ id: 'probe', name: 'probe_harness', args: {
            task: 'PARSE_THE_DOCUMENT',
            recipe: 'coder@1',
            model: 'worker',
            domain: 'parser',
            variants: [
              { label: 'general-way', axis: 'general', harness: { 'rules/worker.md': 'GENERAL_RULE' } },
              { label: 'domain-way', axis: 'specific', harness: { 'rules/worker.md': 'DOMAIN_RULE' } },
            ],
          } }];
          break;
        case 3:
          calls = [{ id: 'decide', name: 'record_harness_decision', args: {
            domain: 'parser', axis: 'general', chosen: 'A',
            cue: 'A file that is not there.',
            lesson: 'Read the file list before reading a file.',
            evidence: 'The general candidate listed the directory first.',
          } }];
          break;
      }
      step++;
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Loop closed.' : 'No suggestion' }, 'stop');
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
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: mainUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' },
      { id: 'worker', provider: 'graph-worker', grade: 'medium', api: 'openai-completions', baseUrl: workerUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' },
    ] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-loop-key' } });
  cleanup.push(() => daemon.close());

  const first = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Close the loop', requestId: 'harness-loop-first' }),
  });
  expect(first.status).toBe(200);

  const waitFor = async (id: string): Promise<string> => {
    // The probe waits for its candidates, and it gives up on its own after
    // 180 seconds. The window here has to be wider than that, or a loaded
    // machine would fail the test before the probe could answer.
    const deadline = Date.now() + 240000;
    while (!results.get(id) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
    return results.get(id) ?? '';
  };

  // 1. The failed tool call is visible in the evidence.
  const evidence = JSON.parse(await waitFor('evidence') || '{}') as {
    nodes: { role: string; toolCalls: number; toolErrors: { tool: string; count: number }[] }[];
    usage: { requests: number };
  };
  const mainNode = evidence.nodes.find(node => node.role === 'master') ?? evidence.nodes[0];
  expect(mainNode!.toolErrors.map(error => error.tool)).toContain('read');
  expect(evidence.usage.requests).toBeGreaterThanOrEqual(1);

  // 2. The probe ran both harnesses on the same task and contrasted them.
  const probe = JSON.parse(await waitFor('probe') || '{}') as {
    graphPhase: string;
    candidates: { label: string; axis: string }[];
    comparison: { candidates: { outputValues: Record<string, string> }[] };
  };
  expect(probe.candidates.map(candidate => candidate.axis).sort()).toEqual(['general', 'specific']);
  // The probe closes its own graph: an experiment is not a project entry that
  // runs forever.
  expect(probe.graphPhase).not.toBe('running');
  expect(probe.comparison.candidates[0]!.outputValues.out).not.toEqual(probe.comparison.candidates[1]!.outputValues.out);

  // 3. The decision was kept, on the general axis.
  const decision = JSON.parse(await waitFor('decide') || '{}') as { axis: string; scope: string; entries: { lesson: string }[] };
  expect(decision.axis).toBe('general');
  expect(decision.scope).toBe('general');
  expect(decision.entries[0]!.lesson).toContain('Read the file list before reading a file.');

  // 4. The next task of the project starts with that lesson.
  const second = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Do unrelated work', requestId: 'harness-loop-second' }),
  });
  expect(second.status).toBe(200);
  const deadline = Date.now() + 60000;
  while (!prompts.some(entry => entry.user.includes('Do unrelated work')) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  const later = prompts.filter(entry => entry.user.includes('Do unrelated work')).map(entry => entry.system).join('\n');
  expect(later).toContain('Lessons earlier runs of this project learned');
  expect(later).toContain('Read the file list before reading a file.');
}, 420_000);
