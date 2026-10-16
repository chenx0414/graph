import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test.each([
  { classifyFriction: true, compactDocs: false, cacheField: 'standard' },
  { classifyFriction: false, compactDocs: false, cacheField: 'standard' },
  { classifyFriction: false, compactDocs: true, cacheField: 'deepseek' },
  { classifyFriction: false, compactDocs: false, cacheField: 'kimi' },
  { classifyFriction: false, compactDocs: false, cacheField: 'unreported' },
  { classifyFriction: false, compactDocs: false, cacheField: 'capacity-retry' },
])('classifyFriction=$classifyFriction/compactDocs=$compactDocs/cache=$cacheField: HTTP conversation executes a real tool and exposes privacy-preserving cost diagnostics through the CLI', async ({ compactDocs, cacheField, classifyFriction }) => {
  const previousFriction = process.env.GRAPH_CLASSIFY_HARNESS_FRICTION;
  process.env.GRAPH_CLASSIFY_HARNESS_FRICTION = classifyFriction ? '1' : '0';
  cleanup.push(async () => { if (previousFriction === undefined) delete process.env.GRAPH_CLASSIFY_HARNESS_FRICTION; else process.env.GRAPH_CLASSIFY_HARNESS_FRICTION = previousFriction; });
  const previous = process.env.GRAPH_COMPACT_DOCUMENTATION;
  process.env.GRAPH_COMPACT_DOCUMENTATION = compactDocs ? '1' : '0';
  cleanup.push(async () => { if (previous === undefined) delete process.env.GRAPH_COMPACT_DOCUMENTATION; else process.env.GRAPH_COMPACT_DOCUMENTATION = previous; });
  const root = await mkdtemp(join(tmpdir(), 'graph-harness-cost-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const usage = cacheField === 'unreported' ? null : { prompt_tokens: 40, completion_tokens: 10,
    ...(cacheField === 'standard' ? { prompt_tokens_details: { cached_tokens: 15 } }
      : cacheField === 'deepseek' ? { prompt_cache_hit_tokens: 15, prompt_cache_miss_tokens: 25 } : { cached_tokens: 15 }),
  };
  const provider = await openaiServer([
    ...(cacheField === 'capacity-retry' ? [{ status: 429 }] : []),
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }], usage },
    { text: 'The proof file is ready.', usage },
  ]);
  cleanup.push(() => provider.close());
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div>Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root }], credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high',
      api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256,
      credentialId: 'local', cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 },
      pricing: { currency: 'USD', unit: 'per_million_tokens', status: 'known', sourceUrl: 'fixture', retrievedAt: '2026-10-16' },
    }] },
  }));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'),
    webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_LOCAL_KEY: 'private-fixture-key' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const response = await fetch(`${daemon.url}/api/conversations`, { method: 'POST', headers,
    body: JSON.stringify({ projectId: 'p', text: 'Create proof.txt with harness-proof. private-user-marker', model: 'local', requestId: 'cost-proof' }) });
  expect(response.status).toBe(200);
  const created = await response.json() as { taskId: string; conversationId: string };
  await expect.poll(async () => {
    const view = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}`, { headers })).json();
    return view.messages.some((message: { role: string; text: string }) => message.role === 'assistant' && message.text.includes('proof file'));
  }, { timeout: 30_000 }).toBe(true);
  expect(await readFile(join(root, 'proof.txt'), 'utf8')).toBe('harness-proof');
  const firstRequest = provider.requests[0] as { messages: { role: string; content: string }[] };
  const instructions = firstRequest.messages.filter(message => message.role === 'system' || message.role === 'developer').map(message => message.content).join('\n');
  expect(instructions.includes('A failing project check, missing project configuration')).toBe(classifyFriction);
  expect(instructions).toContain('the executor and the improver are the same Agent');
  const events = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}/events?limit=500`, { headers })).json() as { type: string; data: Record<string, unknown> }[];
  const profiles = events.filter(event => event.type === 'provider.request_profile');
  expect(profiles).toHaveLength(cacheField === 'capacity-retry' ? 3 : 2);
  expect(JSON.stringify(profiles)).not.toMatch(/private-user-marker|private-fixture-key|printf harness-proof/);
  expect(profiles[0]!.data.staticFingerprint).toBe(profiles[1]!.data.staticFingerprint);
  expect(profiles.at(-1)!.data.sections).toHaveProperty('tool_results');
  // Public statistics read ingests worker telemetry through its real owner.
  expect((await fetch(`${daemon.url}/api/tool-stats`, { headers })).ok).toBe(true);
  const { stdout } = await execute(process.execPath, ['scripts/harness-cost.mjs', join(root, 'state', 'tasks.sqlite')], { cwd: process.cwd() });
  const report = JSON.parse(stdout);
  const task = report.tasks.find((task: { id: string }) => task.id === created.taskId);
  if (cacheField === 'unreported') {
    expect(task.cacheHitRequestRate).toBeNull();
    expect(task.cacheReadFraction).toBeNull();
    expect(task).toMatchObject({ requests: 2, estimatedUsage: 2, cacheMeasuredRequests: 0, cacheUnmeasuredRequests: 2 });
    expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(0);
    expect(report.summary.costPerCompletedTask).toBeNull();
  } else {
    expect(task).toMatchObject({ requests: cacheField === 'capacity-retry' ? 3 : 2, unknownUsage: 0, unknownCost: 0,
      tokens: { input: 50, output: 20, cacheRead: 30, cacheWrite: 0 }, cacheReadFraction: 0.375 });
    expect(task.costs.USD).toBeCloseTo(0.000195, 10);
    expect(report.summary.costPerCompletedTask).toBeNull();
    expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(cacheField === 'capacity-retry' ? 3 : 2);
    expect(task.cacheMeasuredRequests).toBe(2);
    expect(task.cacheUnmeasuredRequests).toBe(cacheField === 'capacity-retry' ? 1 : 0);
    expect(report.summary.costByBillingType.amounts.USD.input).toBeCloseTo(0.0001, 10);
    expect(report.summary.costByBillingType.amounts.USD.output).toBeCloseTo(0.00008, 10);
    expect(report.summary.costByBillingType.amounts.USD.cacheRead).toBeCloseTo(0.000015, 10);
    expect(task.cacheHitRequestRate).toBe(1);
  }
  expect(report.requestProfiles.samples).toBe(cacheField === 'capacity-retry' ? 3 : 2);
  expect(report.tools.find((tool: { tool: string }) => tool.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, taskReach: 1 });
}, 60_000);
