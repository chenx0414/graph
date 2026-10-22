import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { ensureBackendBinary } from '../helpers/backend-binary.ts';

/**
 * A review policy becomes a module the graph really runs.
 *
 * The policy says how a review is judged: which inputs carry the subject and
 * the reports, which dimensions are required, what a failure means. The
 * command turns that into an isolated evaluate module and an ordinary module
 * declaration that connects it.
 *
 * The generated module is not a document: it runs inside the pinned container,
 * reads the values that really landed on its inputs, and decides. A required
 * dimension that failed is a business rework - the graph carries the rework
 * output, the reviewer words and the files to fix - while a report that
 * applies to another version of the artifact is not a verdict at all.
 *
 * The proof is the real command line, a real daemon and a real container: the
 * policy file is read by the command, the entry it writes is the entry the
 * graph runs, and the decision is the one the module really made.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall {
  id: string;
  name: string;
  args: unknown;
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
}

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call answered, so the test reads the graph the way the model read it.
 */
async function masterProvider(plan: () => MasterCall[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The modules are as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    failures,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

const run = promisify(execFile);

/** The policy a review is judged by: one required dimension on one report. */
const multiview = {
  kind: 'multiview', subject: 'implementation', reports: ['review'],
  dimensions: [{ id: 'correctness', required: true, report: 'review' }],
};

test('a generated review module is declared by the command and really judged by the graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-review-module-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const binary = ensureBackendBinary();

  // The command turns the policy into an entry and a module declaration.
  const policyPath = join(root, 'policy.json');
  await writeFile(policyPath, JSON.stringify(multiview));
  const entry = join(root, 'review-policy.mjs');
  const generated = await run(binary, ['review-module', '--policy', policyPath, '--entry', entry], { cwd: root });
  const declaration = JSON.parse(generated.stdout) as {
    type: string; trigger: string; requiredInputs: string[];
    inputs: Record<string, { protocol: string }>;
    outputs: Record<string, { protocol: string }>;
    code: { entry: string; version: number };
  };
  expect(declaration.type).toBe('command');
  expect(declaration.trigger).toBe('each');
  expect(declaration.requiredInputs).toEqual(['implementation', 'review']);
  expect(declaration.inputs).toEqual({ implementation: { protocol: 'data' }, review: { protocol: 'data' } });
  expect(declaration.outputs).toEqual({ approved: { protocol: 'data' }, rework: { protocol: 'data' } });
  expect(declaration.code.entry).toBe(entry);
  expect(declaration.code.version).toBe(1);
  const written = await readFile(entry, 'utf8');
  expect(written).toContain('export function evaluate(environment)');

  // A published code entry is not overwritten: a revision takes a new path.
  const refused = await run(binary, ['review-module', '--policy', policyPath, '--entry', entry], { cwd: root })
    .then(() => null, error => error as { code: number; stderr: string });
  expect(refused, 'the command overwrote a published code entry').not.toBeNull();
  expect(refused?.code).not.toBe(0);
  expect(refused?.stderr).toContain('could not be created');
  expect(await readFile(entry, 'utf8')).toBe(written);

  // A broken policy is refused before anything is written.
  const brokenPath = join(root, 'broken.json');
  await writeFile(brokenPath, JSON.stringify({
    ...multiview, dimensions: [{ id: 'correctness', required: true, report: 'review' }, { id: 'correctness', required: false, report: 'review' }],
  }));
  const brokenEntry = join(root, 'broken.mjs');
  const broken = await run(binary, ['review-module', '--policy', brokenPath, '--entry', brokenEntry], { cwd: root })
    .then(() => null, error => error as { code: number; stderr: string });
  expect(broken, 'the command accepted a broken policy').not.toBeNull();
  expect(broken?.code).not.toBe(0);
  expect(broken?.stderr).toContain('Dimension IDs');
  expect(existsSync(brokenEntry)).toBe(false);

  // The generated module is wired into a real graph and really judged.
  const definition = {
    schemaVersion: 2,
    name: 'Native review',
    protocols: { data: { type: 'object' } },
    nodes: {},
    modules: {
      gate: {
        type: 'command', trigger: 'each',
        requiredInputs: ['implementation', 'review'],
        inputs: { implementation: { protocol: 'data' }, review: { protocol: 'data' } },
        outputs: { approved: { protocol: 'data' }, rework: { protocol: 'data' } },
        code: { entry, version: 1 },
      },
    },
    edges: {},
    inputs: {},
    outputs: { result: { from: 'gate.rework', protocol: 'data' } },
  };

  const graphs: string[] = [];
  const master = await masterProvider(() => {
    const graphId = graphs[0] ?? '';
    const published = JSON.parse(master.results.get('publish') ?? '{}') as { artifactId?: string; version?: number; digest?: string };
    const subject = { artifactId: published.artifactId ?? '', version: published.version ?? 0, digest: published.digest ?? '' };
    return [
      { id: 'publish', name: 'artifact_publish', args: {
        namespace: 'plans', name: 'implementation', content: 'stable implementation content', requestId: 'publish-implementation',
      } },
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition } },
      { id: 'send-subject', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'implementation', value: subject } },
      { id: 'send-review', name: 'graph_send', args: { graphId, nodeId: 'gate', input: 'review', value: {
        schemaVersion: 1,
        subject,
        body: { kind: 'multiview', dimensions: { correctness: {
          verdict: 'fail', reason: 'The legend is not persistent',
          evidence: [subject], files: ['src/web/App.tsx', 'docs/legend.md'],
        } } },
      } } },
      { id: 'module', name: 'graph_inspect', args: { graphId, query: 'module', id: 'gate' },
        before: async () => { await waitForTransitions(graphId, 'gate', 2); } },
      { id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) graphs[0] = found[1]!;
  });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const waitFor = async (read: () => Promise<boolean>) => {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (await read()) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error('the graph never reached the expected state');
  };
  const waitForTransitions = async (graphId: string, moduleId: string, count: number) => {
    await waitFor(async () => {
      const view = await request(`/api/tasks/${graphId}/graph/modules/${moduleId}`);
      const transitions = (view.body as { transitions?: unknown[] }).transitions ?? [];
      return transitions.length >= count;
    });
  };

  try {
    const configPath = join(root, 'graph.config.json');
    const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'review' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { review: { secretRef: 'GRAPH_REVIEW_KEY' } },
      models: { entries: [
        { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_REVIEW_KEY: 'review-synthetic' }, extraArgs: ['--execute'] });

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Judge the review.', requestId: 'review-module' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    await expect.poll(() => master.results.has('results'), { timeout: 180_000, interval: 250 }).toBeTruthy();
    expect(master.failures, JSON.stringify(master.failures)).toEqual([]);

    // The module waited for the report and then judged what really arrived.
    const module = JSON.parse(master.results.get('module')!) as {
      state: { decision: { outcome: string; blockers: { id: string; reason: string; files?: string[] }[]; reviewText: { report: string; verdict: string; reason: string; files?: string[] }[] } };
      transitions: { reason: string; outputs: Record<string, unknown> }[];
    };
    expect(module.transitions[0]?.reason).toContain('waiting for review');
    expect(module.state.decision.outcome).toBe('rework');
    expect(module.state.decision.blockers).toMatchObject([{ id: 'correctness', reason: 'The legend is not persistent', files: ['src/web/App.tsx', 'docs/legend.md'] }]);
    expect(module.state.decision.reviewText).toMatchObject([{ report: 'review', verdict: 'fail', reason: 'The legend is not persistent' }]);
    // The rework really left the module on its own output.
    expect(Object.keys(module.transitions[1]?.outputs ?? {})).toEqual(['rework']);

    // The graph carries the rework to its output.
    const results = JSON.parse(master.results.get('results')!) as { value: { outcome: string } }[];
    expect(results).toMatchObject([{ value: { outcome: 'rework' } }]);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
