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
  response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 200, completion_tokens: 40 } })}\n\n`);
  response.end('data: [DONE]\n\n');
}

const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * A probe whose candidates keep working for longer than the probe's own quiet
 * window, without any execution-state transition.
 *
 * Every turn the candidate makes one real tool call and the provider answers
 * slowly, so the candidates are provably busy while the probe's progress
 * signature (execution state + queue counts) never changes. A probe that reads
 * only that signature calls a working experiment stuck and returns half of its
 * evidence: candidates still running, nothing submitted, nothing to judge.
 */
test('a probe keeps waiting while its candidates are visibly working, even when no execution state changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-probe-quiet-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# project\n');

  // Twelve turns per candidate, three seconds apart: 36 s of continuous tool
  // activity, which outlasts the probe's quiet window on purpose.
  const turns = 12;
  const turnDelayMs = 3000;
  const perCandidate = new Map<string, number>();
  const submitted = new Set<string>();
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const text = JSON.stringify(body.messages);
    const lane = text.includes('VARIANT_ONE') ? 'one' : 'two';
    const step = (perCandidate.get(lane) ?? 0) + 1;
    perCandidate.set(lane, step);
    await pause(turnDelayMs);
    // An accepted submit ends the work; the turn still needs an answer, so the
    // candidate says it is done instead of asking for another tool.
    if (submitted.has(lane)) {
      sse(response, { role: 'assistant', content: 'Work submitted.' }, 'stop');
      return;
    }
    if (step <= turns) {
      sse(response, {
        role: 'assistant',
        tool_calls: [{ index: 0, id: `${lane}-list-${step}`, type: 'function', function: { name: 'list_dir', arguments: JSON.stringify({ path: '.' }) } }],
      }, 'tool_calls');
      return;
    }
    submitted.add(lane);
    sse(response, {
      role: 'assistant',
      tool_calls: [{ index: 0, id: `${lane}-submit`, type: 'function', function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { lane, steps: step - 1 } } } }) } }],
    }, 'tool_calls');
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { worker.closeAllConnections(); await new Promise<void>(resolve => worker.close(() => resolve())); });
  const workerUrl = `http://127.0.0.1:${(worker.address() as AddressInfo).port}/v1`;

  let probeResult = '';
  let asked = false;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'probe_harness') ?? false;
    if (isMain) {
      const results = body.messages.filter(message => message.role === 'tool');
      if (!asked) {
        asked = true;
        const args = {
          task: 'STATE_THE_FACT',
          model: 'worker',
          recipe: 'coder@1',
          timeoutMs: 120000,
          variants: [
            { label: 'variant-one', axis: 'general', recipe: 'coder@1', harness: { 'rules/worker.md': 'Work only inside the assigned task and worktree.\n\nVARIANT_ONE\n' } },
            { label: 'variant-two', axis: 'specific', recipe: 'coder@1', harness: { 'rules/worker.md': 'Work only inside the assigned task and worktree.\n\nVARIANT_TWO\n' } },
          ],
        };
        sse(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'probe-one', type: 'function', function: { name: 'probe_harness', arguments: JSON.stringify(args) } }] }, 'tool_calls');
        return;
      }
      const last = results.length ? results[results.length - 1]!.content : '';
      probeResult = typeof last === 'string' ? last : JSON.stringify(last);
      sse(response, { role: 'assistant', content: 'Probe finished.' }, 'stop');
      return;
    }
    sse(response, { role: 'assistant', content: 'No suggestion' }, 'stop');
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
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-probe-quiet-key' } });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Run one harness probe', requestId: 'harness-probe-quiet' }),
  });
  expect(created.status).toBe(200);

  const deadline = Date.now() + 120000;
  while (!probeResult && Date.now() < deadline) await pause(200);
  expect(probeResult).not.toBe('');

  const result = JSON.parse(probeResult) as {
    timedOut: boolean;
    waitedMs: number;
    candidates: { label: string; nodeId: string }[];
    comparison: { candidates: { anonId: string; status: string; submitted: boolean; outputs: string[]; toolCalls: number }[] };
  };

  // The probe waited for the work instead of calling a busy experiment stuck.
  expect(result.timedOut).toBe(false);
  expect(result.candidates).toHaveLength(2);
  // Both candidates were still working well past the old quiet window, and the
  // probe reported the finished experiment, not a snapshot of it.
  expect(result.waitedMs).toBeGreaterThan(30000);
  expect(result.comparison.candidates).toHaveLength(2);
  for (const candidate of result.comparison.candidates) {
    expect(candidate.status).toBe('completed');
    expect(candidate.submitted).toBe(true);
    expect(candidate.outputs).toContain('out');
    expect(candidate.toolCalls).toBeGreaterThanOrEqual(turns);
  }
}, 180000);
