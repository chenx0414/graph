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

test('the Main Agent can read the evidence of its own run: the tool call that failed, what it did and what it cost', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-evidence-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });

  const observed = new Map<string, string>();
  let step = 0;
  const main = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody;
    const isMain = body.tools?.some(tool => tool.function.name === 'read_harness_evidence') ?? false;
    let calls: { id: string; name: string; args: unknown }[] = [];
    if (isMain) {
      for (const message of body.messages) {
        if (message.role === 'tool' && message.tool_call_id) {
          observed.set(message.tool_call_id, typeof message.content === 'string' ? message.content : JSON.stringify(message.content));
        }
      }
      if (step === 0) {
        // A tool call that fails: the file is not there.
        calls = [{ id: 'failed-read', name: 'read', args: { path: 'missing-report.txt' } }];
      }
      if (step === 1) {
        calls = [{ id: 'evidence', name: 'read_harness_evidence', args: {} }];
      }
      if (step === 2) {
        calls = [{ id: 'trajectory', name: 'read_harness_evidence', args: { kind: 'trajectory' } }];
      }
      step++;
    }
    if (calls.length) {
      sse(response, { role: 'assistant', tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, 'tool_calls');
      return;
    }
    sse(response, { role: 'assistant', content: isMain ? 'Evidence read.' : 'No suggestion' }, 'stop');
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
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { id: 'local', provider: 'graph-local', grade: 'high', api: 'openai-completions', baseUrl: mainUrl, contextWindow: 32000, maxTokens: 4096, credentialId: 'local' },
    ] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_LOCAL_KEY: 'harness-evidence-key' } });
  cleanup.push(() => daemon.close());

  const created = await daemon.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Read your own evidence', requestId: 'harness-evidence' }),
  });
  expect(created.status).toBe(200);

  const resultOf = (id: string): string => observed.get(id) ?? '';
  const deadline = Date.now() + 60000;
  while (!resultOf('trajectory') && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 200));
  expect(resultOf('trajectory')).not.toBe('');

  // The failed tool call is visible, with the tool it was.
  const evidence = JSON.parse(resultOf('evidence') || '{}') as {
    taskId: string;
    nodes: { nodeId: string; role: string; steps: number; toolCalls: number; toolErrors: { tool: string; count: number; reason: string }[] }[];
    failedNodes: { nodeId: string; reason: string }[];
    usage: { requests: number; input: number; output: number };
  };
  expect(evidence.taskId).toBeTruthy();
  const mainNode = evidence.nodes.find(node => node.role === 'master') ?? evidence.nodes[0];
  expect(mainNode).toBeTruthy();
  expect(mainNode!.toolCalls).toBeGreaterThanOrEqual(1);
  expect(mainNode!.toolErrors.map(error => error.tool)).toContain('read');
  expect(mainNode!.toolErrors.find(error => error.tool === 'read')!.count).toBeGreaterThanOrEqual(1);
  // Nothing failed to finish: this run had no blocked node.
  expect(evidence.failedNodes).toEqual([]);
  // The run cost something, and the reading says how much.
  expect(evidence.usage.requests).toBeGreaterThanOrEqual(1);
  expect(evidence.usage.input).toBeGreaterThan(0);

  // The ordered steps of the run are readable as well.
  const trajectory = JSON.parse(resultOf('trajectory') || '{}') as {
    nodes: { nodeId: string; trajectory: { kind: string; tool?: string; isError?: boolean }[] }[];
  };
  const steps = trajectory.nodes.flatMap(node => node.trajectory);
  expect(steps.length).toBeGreaterThanOrEqual(1);
  expect(steps.some(step => step.tool === 'read')).toBe(true);
}, 120_000);
