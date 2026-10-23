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
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 100, completion_tokens: 30 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('a lesson claimed on the general axis reaches every domain, while a domain lesson stays in its domain', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-axes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  // The two candidates differ only in the prompt text they run under: one
  // claims the change for every kind of work, the other for this domain.
  const workerRequests: ProviderBody[] = [];
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    workerRequests.push(body);
    const text = JSON.stringify(body);
    const general = text.includes('GENERAL_VARIANT_RULE');
    const domain = text.includes('DOMAIN_VARIANT_RULE');
    const marker = general ? 'GENERAL_VARIANT_RULE' : 'DOMAIN_VARIANT_RULE';
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

  const observed = new Map<string, string>();
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
          observed.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        }
      }
      const tools = body.messages.filter(message => message.role === 'tool');
      const last = tools.length ? tools[tools.length - 1]!.content : '';
      const lastText = typeof last === 'string' ? last : JSON.stringify(last);
      const graphId = /"graphId"\s*:\s*"([0-9a-f-]{36})"/.exec(lastText)?.[1] ?? '';
      switch (step) {
        case 0:
          calls = [{ id: 'probe', name: 'probe_harness', args: {
            task: 'PARSE_THE_DOCUMENT',
            recipe: 'coder@1',
            model: 'worker',
            domain: 'parser',
            variants: [
              { label: 'general-way', axis: 'general', harness: { 'rules/worker.md': 'GENERAL_VARIANT_RULE' } },
              { label: 'domain-way', axis: 'specific', harness: { 'rules/worker.md': 'DOMAIN_VARIANT_RULE' } },
            ],
          } }];
          break;
        case 1:
          calls = [{ id: 'decide-general', name: 'record_harness_decision', args: {
            graphId, domain: 'parser', axis: 'general', chosen: 'A',
            cue: 'Any task can hit this.', lesson: 'Check the input shape before writing.', evidence: 'The general candidate avoided the mistake.',
          } }];
          break;
        case 2:
          calls = [{ id: 'decide-specific', name: 'record_harness_decision', args: {
            graphId, domain: 'parser', axis: 'specific', chosen: 'B',
            cue: 'This parser has a known trap.', lesson: 'Read the whole document first.', evidence: 'The domain candidate read the document first.',
          } }];
          break;
        case 3:
          calls = [{ id: 'read-parser', name: 'read_harness_experience', args: { domain: 'parser' } }];
          break;
        case 4:
          calls = [{ id: 'read-billing', name: 'read_harness_experience', args: { domain: 'billing' } }];
          break;
      }
      step++;
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Axes recorded.' : 'No suggestion' }, 'stop');
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
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-axes-key' } });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Probe two harness axes and record what each taught', requestId: 'harness-axes' }),
  });
  expect(created.status).toBe(200);

  const resultOf = (id: string): string => observed.get(id) ?? '';
  const deadline = Date.now() + 240000;
  while (!resultOf('read-billing') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  if (!resultOf('probe')) console.log('MISSING RESULTS', JSON.stringify([...observed.entries()]).slice(0, 1500));

  // The probe reports which axis each candidate was claimed on.
  const probe = JSON.parse(resultOf('probe') || '{}') as {
    candidates: { label: string; axis: string; anonId: string }[];
    comparison: { candidates: { nodeId: string; tools: string[]; outputValues: Record<string, string> }[] };
  };
  expect(probe.candidates.map(candidate => candidate.label).sort()).toEqual(['domain-way', 'general-way']);
  expect(probe.candidates.find(candidate => candidate.label === 'general-way')!.axis).toBe('general');
  expect(probe.candidates.find(candidate => candidate.label === 'domain-way')!.axis).toBe('specific');
  // The two candidates produced different answers under their different harness.
  expect(probe.comparison.candidates[0]!.outputValues.out).not.toEqual(probe.comparison.candidates[1]!.outputValues.out);

  // Both decisions are recorded, each in the scope its axis names.
  const generalDecision = JSON.parse(resultOf('decide-general') || '{}') as { axis: string; scope: string; entries: { axis: string }[] };
  expect(generalDecision.axis).toBe('general');
  expect(generalDecision.scope).toBe('general');
  const specificDecision = JSON.parse(resultOf('decide-specific') || '{}') as { axis: string; scope: string; entries: { axis: string }[] };
  expect(specificDecision.axis).toBe('specific');
  expect(specificDecision.scope).toBe('parser');

  // The domain finds both: its own lesson and the general one.
  const parser = JSON.parse(resultOf('read-parser') || '{}') as { entries: { axis: string; lesson: string }[]; general: { axis: string; lesson: string }[] };
  expect(parser.entries).toHaveLength(1);
  expect(parser.entries[0]!.axis).toBe('specific');
  expect(parser.general).toHaveLength(1);
  expect(parser.general[0]!.axis).toBe('general');

  // Another domain finds the general lesson and not the domain one.
  const billing = JSON.parse(resultOf('read-billing') || '{}') as { entries: { axis: string }[]; general: { axis: string; lesson: string }[] };
  expect(billing.entries ?? []).toHaveLength(0);
  expect(billing.general).toHaveLength(1);
  expect(billing.general[0]!.axis).toBe('general');
  expect(billing.general[0]!.lesson).toContain('input shape');
}, 300_000);
