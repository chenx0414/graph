import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const execute = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

for (const { compactDocs, cacheField, classifyFriction, matchSearch, customRules, boundSearch } of [
  { boundSearch: false, matchSearch: true, customRules: false, classifyFriction: true, compactDocs: false, cacheField: 'standard' },
  { boundSearch: true, matchSearch: true, customRules: false, classifyFriction: false, compactDocs: false, cacheField: 'standard' },
  { boundSearch: false, matchSearch: true, customRules: false, classifyFriction: false, compactDocs: false, cacheField: 'standard' },
  { boundSearch: false, matchSearch: true, customRules: true, classifyFriction: false, compactDocs: false, cacheField: 'standard' },
  { boundSearch: false, matchSearch: false, customRules: false, classifyFriction: true, compactDocs: false, cacheField: 'standard' },
  { boundSearch: false, matchSearch: false, customRules: false, classifyFriction: false, compactDocs: false, cacheField: 'standard' },
  { boundSearch: false, matchSearch: false, customRules: false, classifyFriction: false, compactDocs: true, cacheField: 'deepseek' },
  { boundSearch: false, matchSearch: false, customRules: false, classifyFriction: false, compactDocs: false, cacheField: 'kimi' },
  { boundSearch: false, matchSearch: false, customRules: false, classifyFriction: false, compactDocs: false, cacheField: 'unreported' },
  { boundSearch: false, matchSearch: false, customRules: false, classifyFriction: false, compactDocs: false, cacheField: 'capacity-retry' },
]) {
 test.skipIf(boundSearch && !process.env.GRAPH_FFF_EXTENSION_SOURCE)(`boundSearch=${boundSearch}/matchSearch=${matchSearch}/customRules=${customRules}/classifyFriction=${classifyFriction}/compactDocs=${compactDocs}/cache=${cacheField}: HTTP conversation executes a real tool and exposes privacy-preserving cost diagnostics through the CLI`, async () => {
  const previousSearch = process.env.GRAPH_MATCH_SEARCH_GUIDANCE;
  process.env.GRAPH_MATCH_SEARCH_GUIDANCE = matchSearch ? '1' : '0';
  cleanup.push(async () => { if (previousSearch === undefined) delete process.env.GRAPH_MATCH_SEARCH_GUIDANCE; else process.env.GRAPH_MATCH_SEARCH_GUIDANCE = previousSearch; });
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
    { tools: [{ id: 'write-proof', name: 'bash', arguments: JSON.stringify({ command: 'printf harness-proof > proof.txt' }) }, ...(boundSearch ? [{id:'indexed-search',name:'fffind',arguments:JSON.stringify({pattern:'find-proof'})}] : [])], usage },
    { tools: [{id:'read-proof',name:'read',arguments:JSON.stringify({path:'proof.txt'})}], usage },
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
  if(boundSearch){
    const source = process.env.GRAPH_FFF_EXTENSION_SOURCE!;
    const pkg = JSON.parse(await readFile(join(source,'package.json'),'utf8')) as {version:string};
    const capability = join(root,'graph','capabilities','fff');await mkdir(capability,{recursive:true});
    await writeFile(join(root,'find-proof.txt'),'indexed file proof');
    await writeFile(join(capability,'capability.json'),JSON.stringify({id:'fff',kind:'pi-extension',version:pkg.version,name:'Installed FFF',source,base:true,tools:[{name:'fffind',description:'Indexed filename search'},{name:'ffgrep',description:'Indexed content search'}]}));
  }
  const ownerRule = '- Search the repository with indexed ffind and ffgrep. Custom owner policy.';
  if(customRules){
    await mkdir(join(root,'graph','prompts','rules'),{recursive:true});
    await writeFile(join(root,'graph','prompts','rules','common.md'),ownerRule);
  }
  const daemon = await launchCli(root, { configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'),
    webDir, extraArgs: ['--execute'], env: { HOME: root, GRAPH_LOCAL_KEY: 'private-fixture-key' } });
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
  expect(instructions.includes('Repository search tools available in this session:')).toBe(matchSearch && !customRules);
  if(customRules)expect(instructions).toContain(ownerRule);
  if(boundSearch){
    expect(instructions).toContain('Repository search tools available in this session: fffind, ffgrep');
    const second = provider.requests[1] as {messages:{role:string;content:unknown}[]};
    expect(JSON.stringify(second.messages.filter(message=>message.role==='tool'))).toContain('find-proof.txt');
  }
  const events = await (await fetch(`${daemon.url}/api/conversations/${created.conversationId}/events?limit=500`, { headers })).json() as { type: string; data: Record<string, unknown> }[];
  const profiles = events.filter(event => event.type === 'provider.request_profile');
  expect(profiles).toHaveLength(cacheField === 'capacity-retry' ? 4 : 3);
  expect(new Set(profiles.map(profile => profile.data.callId)).size).toBe(profiles.length);
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
    expect(task).toMatchObject({ requests: 3, estimatedUsage: 3, cacheMeasuredRequests: 0, cacheUnmeasuredRequests: 3 });
    expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(0);
    expect(report.summary.costPerCompletedTask).toBeNull();
  } else {
    expect(task).toMatchObject({ requests: cacheField === 'capacity-retry' ? 4 : 3,
      unknownUsage: cacheField === 'capacity-retry' ? 1 : 0, unknownCost: cacheField === 'capacity-retry' ? 1 : 0,
      tokens: { input: 75, output: 30, cacheRead: 45, cacheWrite: 0 }, cacheReadFraction: 0.375 });
    expect(task.costs.USD).toBeCloseTo(0.0002925, 10);
    expect(report.summary.costPerCompletedTask).toBeNull();
    expect(report.summary.costByBillingType.callsWithFrozenRates).toBe(3);
    expect(task.cacheMeasuredRequests).toBe(3);
    expect(task.cacheUnmeasuredRequests).toBe(cacheField === 'capacity-retry' ? 1 : 0);
    expect(report.summary.costByBillingType.amounts.USD.input).toBeCloseTo(0.00015, 10);
    expect(report.summary.costByBillingType.amounts.USD.output).toBeCloseTo(0.00012, 10);
    expect(report.summary.costByBillingType.amounts.USD.cacheRead).toBeCloseTo(0.0000225, 10);
    expect(task.cacheHitRequestRate).toBe(1);
  }
  expect(report.requestProfiles.samples).toBe(cacheField === 'capacity-retry' ? 4 : 3);
  // The report prices the whole tree and shows the prefix each request carried.
  expect(report.summary.costByPurpose.completion.requests).toBe(cacheField === 'capacity-retry' ? 4 : 3);
  // The same spend counted by source and by billing type: what each source
  // cost, split by the type that prices it.
  const cross = report.summary.costByPurposeAndBillingType as Record<string, Record<string, Record<string, number>> | undefined>;
  if (cacheField === 'unreported') {
    // No call carried a frozen rate, so no source can be priced.
    expect(cross.completion).toBeUndefined();
  } else {
    const priced = cross.completion!.USD!;
    expect(priced.input).toBeCloseTo(0.00015, 10);
    expect(priced.output).toBeCloseTo(0.00012, 10);
    expect(priced.cacheRead).toBeCloseTo(0.0000225, 10);
    expect(priced.cacheWrite).toBe(0);
    // The cross adds up to the whole tree priced by billing type.
    const crossed = Object.values(priced).reduce((sum: number, value: number) => sum + value, 0);
    expect(crossed).toBeCloseTo(report.summary.scenarioCost.USD.total, 12);
  }
  // A request whose usage was never reported carries no evidence of its prefix.
  const measured = cacheField === 'unreported' ? 0 : 3;
  expect(report.summary.contextPerRequest.cacheRead.requests).toBe(measured);
  if (measured) {
    expect(report.summary.contextPerRequest.cacheRead.mean).toBe(15);
    expect(report.summary.contextPerRequest.cacheRead.max).toBe(15);
  } else {
    expect(report.summary.contextPerRequest.cacheRead.mean).toBeNull();
  }
  if (cacheField === 'unreported') {
    expect(report.summary.scenarioCost).toEqual({});
    expect(report.summary.scenarioCostByPurpose).toEqual({});
  } else {
    expect(report.summary.scenarioCost.USD.total).toBeGreaterThan(0);
    expect(report.summary.scenarioCost.USD.byBillingType.cacheRead.tokens).toBe(45);
    // The scenario, source by source: every source of spend, split by the
    // billing type that prices it.
    const byPurpose = report.summary.scenarioCostByPurpose as Record<string, { USD: { byBillingType: Record<string, { tokens: number; amount: number }>; total: number } } | undefined>;
    const completion = byPurpose.completion!.USD!;
    expect(completion.byBillingType.cacheRead!.tokens).toBe(45);
    expect(completion.total).toBeCloseTo(report.summary.scenarioCost.USD.total, 12);
    // The sources add up to the tree.
    const summed = Object.values(byPurpose).reduce((sum: number, entry) => sum + entry!.USD!.total, 0);
    expect(summed).toBeCloseTo(report.summary.scenarioCost.USD.total, 12);
  }
  expect(report.tools.find((tool: { tool: string }) => tool.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, taskReach: 1 });
  // One executed bash result is resent on both later provider requests; read is sent once.
  expect(report.requestProfiles.toolResults.find((row:{tool:string})=>row.tool==='bash')).toMatchObject({requestViews:2,resultViews:2});
  expect(report.requestProfiles.toolResults.find((row:{tool:string})=>row.tool==='read')).toMatchObject({requestViews:1,resultViews:1});
  const attributedBytes=report.requestProfiles.toolResults.reduce((sum:number,row:{bytes:number})=>sum+row.bytes,0);
  expect(attributedBytes).toBe(report.requestProfiles.sources.tool_results.bytes);
  expect(JSON.stringify(profiles.map(profile=>profile.data.toolResults))).not.toMatch(/private-user-marker|private-fixture-key|harness-proof|proof.txt|write-proof|read-proof/);

}, 60_000);

}
