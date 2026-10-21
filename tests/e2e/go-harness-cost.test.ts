import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * What a run actually cost.
 *
 * The cost report is read out of the ledger the daemon itself writes, not out
 * of anything the report computes on its own. That makes it a claim about the
 * backend: if the Go daemon records a different number of requests, tokens or
 * billed amounts than the run really used, the report says so.
 *
 * The report also has to be privacy-preserving. A request profile describes
 * the *shape* of a provider request - how many bytes the instructions took,
 * how many bytes a tool result took - and never the text. A user's own words,
 * a credential and the content of a file the Agent wrote must never show up
 * in it.
 *
 * The proof drives the real Go process over real HTTP with a real provider
 * socket, and then runs the real report script over the database that process
 * left behind.
 */

const execute = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** The usage every scripted answer reports: 40 prompt tokens, 15 of them cached. */
const USAGE = { prompt_tokens: 40, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 15 } };

interface Profile {
  callId?: string;
  staticFingerprint?: string;
  sections?: Record<string, { bytes: number; estimatedTokens: number }>;
  toolResults?: { tool: string | null; resultViews: number; bytes: number; estimatedTokens: number }[];
  rates?: Record<string, number> | null;
  pricing?: { currency?: string } | null;
}

interface HarnessReport {
  summary: {
    tasks: number;
    completedTasks: number;
    completedKnownCosts: Record<string, number>;
    costByBillingType: { callsWithFrozenRates: number; amounts: Record<string, Record<string, number>> };
    costPerCompletedTask: Record<string, number> | null;
    requests: number;
    unknownCost: number;
    tokens: Record<string, number>;
  };
  requestProfiles: {
    samples: number;
    distinctStaticFingerprints: number;
    sources: Record<string, { bytes: number; estimatedTokens: number }>;
    toolResults: { tool: string | null; requestViews: number; resultViews: number; bytes: number }[];
  };
  tools: { tool: string; calls: number; errors: number; taskReach: number | null }[];
  tasks: {
    id: string; phase: string; requests: number; unknownUsage: number; estimatedUsage: number; unknownCost: number;
    measuredRequests: number; cacheMeasuredRequests: number; cacheUnmeasuredRequests: number;
    cacheHitRequestRate: number | null; cacheReadFraction: number | null;
    tokens: Record<string, number>; costs: Record<string, number>;
  }[];
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-harness-cost-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // One model only: a second model would give the backend somebody else to ask
  // for a composer suggestion, and that request is not part of the run.
  const provider = await openaiServer([
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }], usage: USAGE },
    { tools: [{ id: 'read-proof', name: 'read', arguments: JSON.stringify({ path: 'proof.txt' }) }], usage: USAGE },
    { text: 'The proof file is ready.', usage: USAGE },
  ]);
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local',
      cost: { input: 2, output: 4, cacheRead: 0.5, cacheWrite: 1 },
      pricing: { currency: 'USD', unit: 'per_million_tokens', status: 'known', sourceUrl: 'fixture', retrievedAt: '2026-10-20' } }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    env: { GRAPH_LOCAL_KEY: 'private-fixture-key' },
    extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as T };
  };
  return { root, project, provider, daemon, request };
}

test('the cost report reads the Go daemon\'s own ledger', async () => {
  const f = await fixture();

  const created = await f.request<{ taskId: string; conversationId: string }>('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Create proof.txt with harness-proof. private-user-marker', requestId: 'cost-proof' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);

  // The run really happened: two tools ran in the workspace and the Agent read
  // back what it had written.
  await expect.poll(async () => f.request<{ master?: { status?: string } }>(`/api/conversations/${created.body.conversationId}`)
    .then(view => view.body.master?.status), { timeout: 90_000, interval: 250 }).toBe('succeeded');
  expect(await readFile(join(f.project, 'proof.txt'), 'utf8')).toBe('harness-proof');
  const readBack = JSON.stringify(f.provider.requests.at(-1));
  expect(readBack).toContain('harness-proof');

  // The daemon described every provider request it made, and the description
  // is about shape only.
  const events = await f.request<Profile[]>('/api/conversations/' + created.body.conversationId + '/events?limit=500');
  const profiles = events.body.filter(event => (event as unknown as { type?: string }).type === 'provider.request_profile')
    .map(event => (event as unknown as { data: Profile }).data);
  expect(profiles).toHaveLength(3);
  expect(new Set(profiles.map(profile => profile.callId)).size).toBe(profiles.length);
  // The instructions did not change between the turns, so the static shape did
  // not change either.
  expect(profiles[0]?.staticFingerprint).toBe(profiles[1]?.staticFingerprint);
  expect(profiles.at(-1)?.sections).toHaveProperty('tool_results');
  // A profile is not a transcript.
  const serialized = JSON.stringify(profiles);
  expect(serialized).not.toMatch(/private-user-marker|private-fixture-key|printf harness-proof/);

  // The report is read out of the database the daemon left behind.
  await f.daemon.close();
  const { stdout } = await execute(process.execPath, ['scripts/harness-cost.mjs', join(f.root, 'state', 'tasks.sqlite')]);
  const report = JSON.parse(stdout) as HarnessReport;
  const task = report.tasks.find(row => row.id === created.body.taskId);
  expect(task, 'the daemon left no task row for the run').toBeTruthy();

  // Three provider requests, three accounted requests, and the tokens the
  // provider reported: 40 prompt tokens of which 15 were cached.
  expect(task).toMatchObject({
    requests: 3,
    unknownUsage: 0,
    estimatedUsage: 0,
    unknownCost: 0,
    measuredRequests: 3,
    cacheMeasuredRequests: 3,
    cacheUnmeasuredRequests: 0,
    tokens: { input: 75, output: 30, cacheRead: 45, cacheWrite: 0 },
  });
  expect(task?.cacheHitRequestRate).toBe(1);
  expect(task?.cacheReadFraction).toBeCloseTo(0.375, 10);

  // The cost is the frozen rate of the model that answered, applied to the
  // tokens it reported.
  expect(task?.costs.USD).toBeCloseTo(0.0002925, 10);
  expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(3);
  const billed = report.summary.costByBillingType.amounts.USD ?? {};
  expect(billed.input).toBeCloseTo(0.00015, 10);
  expect(billed.output).toBeCloseTo(0.00012, 10);
  expect(billed.cacheRead).toBeCloseTo(0.0000225, 10);

  // The profiles are the daemon's own, and the report read all of them.
  expect(report.requestProfiles.samples).toBe(3);
  expect(report.requestProfiles.distinctStaticFingerprints).toBe(1);

  // Both tools ran, and neither failed.
  expect(report.tools.find(row => row.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, taskReach: 1 });
  expect(report.tools.find(row => row.tool === 'read')).toMatchObject({ calls: 1, errors: 0, taskReach: 1 });

  // The bash result travelled with the next two requests; the read result
  // travelled with the one after it.
  expect(report.requestProfiles.toolResults.find(row => row.tool === 'bash')).toMatchObject({ requestViews: 2, resultViews: 2 });
  expect(report.requestProfiles.toolResults.find(row => row.tool === 'read')).toMatchObject({ requestViews: 1, resultViews: 1 });
  const attributed = report.requestProfiles.toolResults.reduce((sum, row) => sum + row.bytes, 0);
  expect(attributed).toBe(report.requestProfiles.sources.tool_results?.bytes);
  // Even the shape of the tool results stays free of what the tools said.
  expect(JSON.stringify(report.requestProfiles.toolResults)).not.toMatch(/private-user-marker|private-fixture-key|harness-proof|proof\.txt/);
}, 180_000);
