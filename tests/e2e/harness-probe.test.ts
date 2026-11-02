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

interface ExecutionItem {
  NodeId?: string;
  State?: string;
  nodeId?: string;
  state?: string;
}

interface ProviderBody {
  tools?: { function: { name: string } }[];
  messages: { role: string; content: unknown; tool_call_id?: string }[];
}

function sse(response: import('node:http').ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 120, completion_tokens: 40 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

test('the main agent compares the candidates of one task without learning which lane produced which answer, and keeps the lesson it adopted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-probe-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  // Two candidates, two harnesses: the same task, two different agent
  // identities. The daemon publishes both definitions at startup.
  const workerRequests: ProviderBody[] = [];
  let alphaSteps = 0;
  let betaSteps = 0;
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    workerRequests.push(body);
    const isReviewer = JSON.stringify(body).includes('Review only the frozen evidence');
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (isReviewer) {
      betaSteps++;
      if (betaSteps === 1) calls = [{ id: 'beta-artifacts', name: 'artifact_list', args: { namespace: 'summaries' } }];
      if (betaSteps === 2) calls = [{ id: 'beta-submit', name: 'submit', args: { outputs: { out: { enable: true, value: { ok: true, lane: 'beta' } } } } }];
    } else {
      alphaSteps++;
      if (alphaSteps === 1) calls = [{ id: 'alpha-list', name: 'list_dir', args: { path: '.' } }];
      if (alphaSteps === 2) calls = [{ id: 'alpha-submit', name: 'submit', args: { outputs: { out: { enable: true, value: { ok: true, lane: 'alpha' } } } } }];
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: 'Candidate finished.' }, 'stop');
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve())); });
  const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1`;

  const definition = {
    schemaVersion: 2,
    name: 'Harness probe candidates',
    protocols: { job: { type: 'object' }, done: { type: 'object' } },
    nodes: {
      alpha: { recipe: 'coder@1', model: 'worker', task: 'PARSE_THE_DOCUMENT', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
      beta: { recipe: 'reviewer@1', model: 'worker', task: 'PARSE_THE_DOCUMENT', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
    },
    modules: {},
    edges: {},
    inputs: { alpha: { to: 'alpha.in', protocol: 'job' }, beta: { to: 'beta.in', protocol: 'job' } },
    outputs: { alpha: { from: 'alpha.out', protocol: 'done' }, beta: { from: 'beta.out', protocol: 'done' } },
  };

  const observed = new Map<string, string>();
  let graphId = '';
  let alphaSent = false;
  let betaSent = false;
  let compared = false;
  let decided = false;
  let recalled = false;
  let callSeq = 0;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'compare_harness_candidates') ?? false;
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
      graphId ||= /"graphId"\s*:\s*"([0-9a-f-]{36})"/.exec(lastText)?.[1] ?? '';
      let executions: { nodeId: string; state: string }[] = [];
      try {
        const parsed = JSON.parse(lastText) as { Items?: ExecutionItem[]; items?: ExecutionItem[] };
        const items = parsed.Items ?? parsed.items;
        if (Array.isArray(items)) executions = items.map(item => ({ nodeId: item.NodeId ?? item.nodeId ?? '', state: item.State ?? item.state ?? '' }));
      } catch { /* the last result is not an execution list */ }
      const settled = (nodeId: string) => executions.some(item => item.nodeId === nodeId && item.state === 'completed');
      const next = (name: string, args: unknown) => [{ id: `call-${++callSeq}-${name}`, name, args }];
      if (!graphId) calls = next('graph_create', { definition });
      else if (!alphaSent) { alphaSent = true; calls = next('graph_send', { graphId, nodeId: 'alpha', input: 'in', value: { goal: 'PARSE_THE_DOCUMENT' } }); }
      else if (!settled('alpha')) calls = next('graph_inspect', { graphId, query: 'executions' });
      else if (!betaSent) { betaSent = true; calls = next('graph_send', { graphId, nodeId: 'beta', input: 'in', value: { goal: 'PARSE_THE_DOCUMENT' } }); }
      else if (!settled('beta')) calls = next('graph_inspect', { graphId, query: 'executions' });
      else if (!compared) { compared = true; calls = next('compare_harness_candidates', { graphId, nodeIds: ['alpha', 'beta'], domain: 'parser' }); }
      else if (!decided) { decided = true; calls = next('record_harness_decision', { graphId, domain: 'parser', chosen: 'A', cue: 'Both candidates parse the same document.', lesson: 'The careful candidate reads the workspace before answering.', evidence: 'The careful candidate made two tool calls before submitting.' }); }
      else if (!recalled) { recalled = true; calls = next('read_harness_experience', { domain: 'parser' }); }
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Harness comparison complete.' : 'No suggestion' }, 'stop');
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
  const daemon = await launchCli(root, {
    configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-probe-key' },
  });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Compare two candidate harnesses for the parser task', requestId: 'harness-probe' }),
  });
  expect(created.status).toBe(200);

  const resultOf = (name: string): string => {
    for (const [id, value] of observed) if (id.endsWith(`-${name}`)) return value;
    return '';
  };
  const deadline = Date.now() + 60000;
  while (!resultOf('read_harness_experience') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));

  // Both candidates ran the same task under different harnesses.
  expect(workerRequests.length).toBeGreaterThanOrEqual(4);
  const workerBodies = JSON.stringify(workerRequests);
  expect(workerBodies).toContain('PARSE_THE_DOCUMENT');
  expect(workerBodies).toContain('Work only inside the assigned task and worktree');
  expect(workerBodies).toContain('Review only the frozen evidence');

  const comparison = JSON.parse(resultOf('compare_harness_candidates') || '{}') as {
    graphId: string; baseline: string;
    candidates: { anonId: string; nodeId: string; status: string; submitted: boolean; outputs: string[]; toolCalls: number; tools: string[] }[];
    differences: Record<string, { field: string; baseline: string; candidate: string }[]>;
    experience: unknown[];
  };
  expect(comparison.candidates).toHaveLength(2);
  expect(comparison.candidates.map(candidate => candidate.anonId)).toEqual(['A', 'B']);
  expect(comparison.candidates.map(candidate => candidate.nodeId).sort()).toEqual(['alpha', 'beta']);
  expect(comparison.candidates.every(candidate => candidate.submitted)).toBe(true);
  expect(comparison.candidates.every(candidate => candidate.outputs.includes('out'))).toBe(true);
  // The candidates behaved differently, and the contrast says where.
  expect(comparison.candidates[0]!.tools).not.toEqual(comparison.candidates[1]!.tools);
  const challenger = comparison.candidates.find(candidate => candidate.anonId !== comparison.baseline)!;
  expect(comparison.differences[challenger.anonId]?.some(difference => difference.field === 'tools')).toBe(true);
  expect(comparison.differences[challenger.anonId]?.some(difference => difference.field === 'outputValues')).toBe(true);
  // A comparison of an untouched domain carries no lessons yet.
  expect(comparison.experience).toEqual([]);

  const decision = JSON.parse(resultOf('record_harness_decision') || '{}') as { domain: string; chosen: string; entry?: { chosen: string; cue: string; lesson: string; evidence: string }; entries?: unknown };
  expect(decision.domain).toBe('parser');
  // The record names the candidate, not the letter it wore inside the
  // comparison: a lesson read later has to say what was chosen.
  expect(decision.chosen).toBe('alpha');
  expect(decision.entry?.chosen).toBe('alpha');
  expect(decision.entries, 'the write still echoes the whole scope').toBeUndefined();
  expect(decision.entry?.lesson).toContain('careful candidate');

  const memory = JSON.parse(resultOf('read_harness_experience') || '{}') as { domain: string; entries: { cue: string; lesson: string; evidence: string }[] };
  expect(memory.domain).toBe('parser');
  expect(memory.entries).toHaveLength(1);
  expect(memory.entries[0]!.cue).toContain('parse the same document');
  expect(memory.entries[0]!.evidence).toContain('two tool calls');
}, 150_000);

test('a harness probe runs one task under two harnesses and reports what each candidate did differently', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-probe-run-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  // The two candidates run the same task under different prompt texts. The
  // scripted provider tells them apart by the text that replaced the node
  // rules, so the test fails if the replacement never reaches the model.
  const workerRequests: ProviderBody[] = [];
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    workerRequests.push(body);
    const text = JSON.stringify(body);
    const alpha = text.includes('VARIANT_ALPHA_RULE');
    const beta = text.includes('VARIANT_BETA_RULE');
    const steps = workerRequests.filter(seen => JSON.stringify(seen).includes(alpha ? 'VARIANT_ALPHA_RULE' : 'VARIANT_BETA_RULE')).length;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (alpha && steps === 1) calls = [{ id: 'alpha-list', name: 'list_dir', args: { path: '.' } }];
    if (alpha && steps === 2) calls = [{ id: 'alpha-submit', name: 'submit', args: { outputs: { out: { enable: true, value: { ok: true, lane: 'alpha' } } } } }];
    if (beta && steps === 1) calls = [{ id: 'beta-artifacts', name: 'artifact_list', args: { namespace: 'summaries' } }];
    if (beta && steps === 2) calls = [{ id: 'beta-submit', name: 'submit', args: { outputs: { out: { enable: true, value: { ok: true, lane: 'beta' } } } } }];
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
  let probed = false;
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
      if (!probed) {
        probed = true;
        calls = [{ id: 'probe', name: 'probe_harness', args: {
          task: 'PARSE_THE_DOCUMENT',
          recipe: 'coder@1',
          model: 'worker',
          domain: 'parser',
          variants: [
            { label: 'alpha', harness: { 'rules/worker.md': 'VARIANT_ALPHA_RULE' } },
            { label: 'beta', harness: { 'rules/worker.md': 'VARIANT_BETA_RULE' } },
          ],
        } }];
      }
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Probe finished.' : 'No suggestion' }, 'stop');
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
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-probe-key' } });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Probe two harness variants for the parser task', requestId: 'harness-probe-run' }),
  });
  expect(created.status).toBe(200);

  const resultOf = (name: string): string => {
    for (const [id, value] of observed) if (id.endsWith(`-${name}`) || id === name) return value;
    return '';
  };
  const deadline = Date.now() + 90000;
  while (!resultOf('probe') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));

  // Both candidates really ran the same task, each under its own harness.
  const workerBodies = JSON.stringify(workerRequests);
  expect(workerBodies).toContain('VARIANT_ALPHA_RULE');
  expect(workerBodies).toContain('VARIANT_BETA_RULE');
  expect(workerBodies.match(/PARSE_THE_DOCUMENT/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

  const probe = JSON.parse(resultOf('probe') || '{}') as {
    graphId: string;
    candidates: { label: string; nodeId: string; anonId: string }[];
    timedOut: boolean;
    comparison: {
      candidates: { anonId: string; nodeId: string; submitted: boolean; tools: string[] }[];
      differences: Record<string, { field: string }[]>;
    };
  };
  expect(probe.timedOut).toBe(false);
  expect(probe.graphId).toBeTruthy();
  expect(probe.candidates.map(candidate => candidate.label).sort()).toEqual(['alpha', 'beta']);
  expect(probe.candidates.map(candidate => candidate.anonId).sort()).toEqual(['A', 'B']);
  expect(probe.comparison.candidates).toHaveLength(2);
  expect(probe.comparison.candidates.every(candidate => candidate.submitted)).toBe(true);
  // The candidates behaved differently, and the contrast says where.
  expect(probe.comparison.candidates[0]!.tools).not.toEqual(probe.comparison.candidates[1]!.tools);
  const challenger = probe.comparison.candidates.find(candidate => candidate.anonId !== probe.comparison.candidates[0]!.anonId)!;
  expect(probe.comparison.differences[challenger.anonId]?.some(difference => difference.field === 'tools')).toBe(true);
}, 150_000);
