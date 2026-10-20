import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { InMemoryCredentialStore, type Model } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { tokenUsageTotal, type TokenUsage } from '../../src/runtime/call-broker.ts';
import { TaskStore, SCHEMA_VERSION } from '../../src/core/store.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  cleanup.length = 0;
});
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-compaction-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

const LONG_TEXT = 'The worker keeps going. '.repeat(280); // ~6300 chars ≈ 1500 estimated tokens

/** Local provider. Requests without a tool list are Pi summarization calls;
 * everything else is a normal agent turn. */
async function compactionProvider(plan: (input: { index: number; tools: string[]; summary: boolean }) => {
  text?: string; finish?: string; usage?: { prompt_tokens: number; completion_tokens: number } | null; pause?: () => Promise<void>;
}) {
  const requests: { model: string | undefined; tools: string[]; messages: { role?: string; content?: unknown }[]; summary: boolean }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as { model?: string; tools?: { function?: { name?: string } }[]; messages?: { role?: string; content?: unknown }[] } : {};
    const tools = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    const summary = tools.length === 0;
    const index = requests.length;
    requests.push({ model: body.model, tools, messages: body.messages ?? [], summary });
    const step = plan({ index, tools, summary });
    await step.pause?.();
    // `undefined` means "use the default billing evidence"; explicit null means
    // the provider returned no authoritative usage.
    const usage = step.usage === undefined ? { prompt_tokens: 50, completion_tokens: 10 } : step.usage;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const chunk = (delta: unknown, finish: string | null) => response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: step.text ?? 'local reply' }, null);
    const finish = step.finish ?? 'stop';
    chunk({}, finish);
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: finish }], usage })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model<'openai-completions'> = {
    id: 'local', name: 'Local', provider: 'local', api: 'openai-completions', baseUrl,
    reasoning: false, input: ['text'], contextWindow: 2_048, maxTokens: 256,
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  modelRuntime.registerProvider('local', { baseUrl, api: 'openai-completions', apiKey: 'local-key', models: [model] });
  return { baseUrl, modelRuntime, requests };
}

function modelEntry(baseUrl: string, modelId?: string) {
  return {
    id: 'local', provider: 'local', grade: 'high' as const, api: 'openai-completions' as const, baseUrl,
    contextWindow: 2_048, maxTokens: 256, credentialId: 'c',
    ...(modelId ? { modelId } : {}),
    cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
  };
}

/** Every instance total must equal the sum of its own invocations, so a
 * summary can never be charged twice or dropped from `used`. */
function instanceTotals(root: string) {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  try {
    const instances = db.prepare('SELECT id,used FROM instances ORDER BY id').all() as { id: string; used: number }[];
    const invocations = db.prepare('SELECT instance_id,usage FROM invocations').all() as { instance_id: string; usage: string | null }[];
    const sums = new Map<string, number>();
    for (const row of invocations) {
      if (!row.usage) continue;
      const tokens = tokenUsageTotal(JSON.parse(row.usage) as TokenUsage);
      sums.set(row.instance_id, (sums.get(row.instance_id) ?? 0) + tokens);
    }
    return instances.map(instance => ({ id: instance.id, used: instance.used, expected: sums.get(instance.id) ?? 0 }));
  } finally { db.close(); }
}

function purposes(root: string) {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  try {
    return db.prepare('SELECT purpose, model, usage, cost FROM invocations ORDER BY rowid').all() as { purpose: string; model: string; usage: string | null; cost: string | null }[];
  } finally { db.close(); }
}

test('compaction settings derive from the model window and response budget', async () => {
  const { compactionSettings } = await import('../../src/runtime/compaction.ts');
  expect(compactionSettings({ contextWindow: 200_000, maxTokens: 8_192 })).toEqual({ enabled: true, reserveTokens: 8_192, keepRecentTokens: 20_000 });
  expect(compactionSettings({ contextWindow: 2_048, maxTokens: 256 })).toEqual({ enabled: true, reserveTokens: 1_024, keepRecentTokens: 1_024 });
  // A window smaller than the fixed 1024 reservation still gets a reserve that
  // leaves room to compact instead of an unusable negative threshold.
  const tiny = compactionSettings({ contextWindow: 512, maxTokens: 128 });
  expect(tiny).toEqual({ enabled: true, reserveTokens: 256, keepRecentTokens: 1_024 });
});

test('a leaked session summary retries the same master turn instead of ending the chat', async () => {
  const root = await temp('summary-leak');
  const leaked = `I found the cause.\n\n<analysis>\n${'Internal chronology. '.repeat(130)}\n</analysis>\n<summary>\n${'Handoff facts. '.repeat(130)}\n</summary>`;
  const provider = await compactionProvider(({ index }) => ({
    text: index === 0 ? leaked : '这是针对原问题的正式答复。',
  }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: '查明最近两轮为什么输出摘要。', requestId: 'create' });
  await runtime.host.runReady();
  for (let attempt = 0; attempt < 40 && provider.requests.length < 2; attempt += 1) {
    await runtime.host.runReady();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(provider.requests.filter(request => !request.summary)).toHaveLength(2);
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.filter(message => message.role === 'assistant').map(message => message.text))
    .toEqual(['这是针对原问题的正式答复。']);
  expect(JSON.stringify(provider.requests[1]!.messages)).toContain('上一轮输出了内部会话摘要');
  expect(instanceTotals(root).every(instance => instance.used === instance.expected)).toBe(true);
}, 60_000);

test('repeated leaked summaries stop after one automatic retry without a false assistant reply', async () => {
  const root = await temp('repeated-summary-leak');
  const leaked = `<analysis>\n${'Internal chronology. '.repeat(130)}\n<summary>\n${'Handoff facts. '.repeat(130)}\n</summary>`;
  const provider = await compactionProvider(() => ({ text: leaked }));
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: '解释故障。', requestId: 'create' });
  await runtime.host.runReady();
  for (let attempt = 0; attempt < 40 && provider.requests.length < 2; attempt += 1) {
    await runtime.host.runReady();
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(provider.requests.filter(request => !request.summary)).toHaveLength(2);
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.filter(message => message.role === 'assistant')).toEqual([]);
  expect(view.messages.some(message => message.kind === 'error' && message.text.includes('内部会话摘要'))).toBe(true);
}, 60_000);

test('Graph retries compaction before the next turn when the window is still full', async () => {
  const root = await temp('preemptive');
  const provider = await compactionProvider(({ summary, index }) => {
    if (summary) {
      // Pi's own threshold compaction truncates first; Graph's bounded retry
      // before the next turn succeeds.
      return index === 1
        ? { text: '## Goal\npartial', finish: 'length', usage: { prompt_tokens: 900, completion_tokens: 256 } }
        : { text: '## Goal\nbounded handoff', usage: { prompt_tokens: 900, completion_tokens: 30 } };
    }
    return index === 0
      ? { text: LONG_TEXT, usage: { prompt_tokens: 2_000, completion_tokens: 40 } }
      : { text: '第二轮回复', usage: { prompt_tokens: 100, completion_tokens: 10 } };
  });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: '第一轮：先聊一下。', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.chat(created.conversationId, { text: '第二轮：继续。', requestId: 'chat' });
  await runtime.host.runReady();
  // Let the second turn settle before reading the ledger.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const probe = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
    const states = (probe.prepare('SELECT state FROM operations').all() as { state: string }[]).map(row => row.state);
    probe.close();
    if (states.length >= 2 && states.every(state => state !== 'intent' && state !== 'dispatched')) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }

  const order = provider.requests.map(request => request.summary ? 'summary' : 'completion');
  console.log('[compaction-fixture] order=', JSON.stringify(order));
  // The second turn compacts before it is sent, so a conversation whose window
  // is still full gets another chance with the bounded instructions.
  expect(order[0]).toBe('completion');
  expect(order.slice(1).filter(kind => kind === 'summary').length).toBeGreaterThanOrEqual(2);
  // The pre-turn summary must leave the worker ready for the user's actual
  // request; recording a successful summary alone does not complete the turn.
  expect(order.filter(kind => kind === 'completion')).toHaveLength(2);
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.messages.some(message => message.role === 'assistant' && message.text === '第二轮回复')).toBe(true);
  expect(instanceTotals(root).every(instance => instance.used === instance.expected)).toBe(true);
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  const compacted = (db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='session.compacted'").get() as { count: number }).count;
  const failed = (db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='session.compaction_failed'").get() as { count: number }).count;
  db.close();
  expect(compacted).toBeGreaterThanOrEqual(1);
  expect(failed).toBeGreaterThanOrEqual(1);
}, 60_000);

test('a summarizer that hits its output cap fails cleanly instead of poisoning the turn', async () => {
  const root = await temp('cap');
  const provider = await compactionProvider(({ summary }) => summary
    // Pi rejects a summary whose generation was cut off by the output cap.
    ? { text: '## Goal\npartial summary', finish: 'length', usage: { prompt_tokens: 900, completion_tokens: 256 } }
    : { text: LONG_TEXT, usage: { prompt_tokens: 50, completion_tokens: 10 } });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: '第一轮：先聊一下。', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.chat(created.conversationId, { text: '第二轮：继续。', requestId: 'chat' });
  await runtime.host.runReady();
  await runtime.conversations.compact(created.conversationId, { requestId: 'compact' });
  await runtime.host.runReady();

  expect(provider.requests.filter(request => request.summary)).toHaveLength(1);
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  const failures = (db.prepare("SELECT data FROM events WHERE type='session.compaction_failed'").all() as { data: string }[])
    .map(row => JSON.parse(row.data) as { reason: string; error: string });
  const openQuestions = db.prepare("SELECT kind FROM questions WHERE status='open'").all() as { kind: string }[];
  db.close();
  // The failure is recorded with its reason and routed as a normal execution
  // failure, not as an unexplained unknown-usage hold that parks the
  // conversation behind an uncertain dispatch.
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ reason: 'manual' });
  expect(failures[0]!.error).toMatch(/token (?:cap|limit)/);
  expect(openQuestions.map(question => question.kind)).not.toContain('unknown_usage');
}, 60_000);

test('Graph compacts before the window is exceeded and asks for a bounded summary', async () => {
  const { COMPACTION_INSTRUCTIONS, latestContextTokens, shouldCompactContext } = await import('../../src/runtime/compaction.ts');
  const entry = { contextWindow: 131_072, maxTokens: 8_192 };
  // Threshold is window - reserve; 122880 for this model.
  expect(shouldCompactContext(entry, null)).toBe(false);
  expect(shouldCompactContext(entry, 100_000)).toBe(false);
  expect(shouldCompactContext(entry, 122_881)).toBe(true);
  expect(shouldCompactContext(entry, 133_937)).toBe(true);
  expect(shouldCompactContext(entry, Number.NaN)).toBe(false);
  // The instructions must counter Pi's "preserve every previous detail" update
  // prompt, which is what makes the summary grow past the output cap.
  expect(COMPACTION_INSTRUCTIONS).toMatch(/under roughly 1500 tokens/);
  expect(COMPACTION_INSTRUCTIONS).toMatch(/[Dd]rop resolved detail/);

  const zero = JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const full = JSON.stringify({ input: 1_530, output: 1, cacheRead: 133_760, cacheWrite: 0 });
  // Pi writes zero-usage placeholders after an overflowed call. They must not
  // hide the last real context size.
  expect(latestContextTokens([
    { usage: zero, settledAt: 200 },
    { usage: full, settledAt: 100 },
  ])).toBe(135_291);
  // A successful manual compaction is newer than the completion it summarized,
  // so the next turn uses the smaller post-compaction estimate.
  expect(latestContextTokens(
    [{ usage: full, settledAt: 100 }],
    { timestamp: 200, data: JSON.stringify({ tokensAfter: 18_000 }) },
  )).toBe(18_000);
  // A completion produced after a successful compaction is newer and wins.
  expect(latestContextTokens(
    [{ usage: JSON.stringify({ input: 4_000, output: 20, cacheRead: 2_000 }), settledAt: 300 }],
    { timestamp: 200, data: JSON.stringify({ tokensAfter: 18_000 }) },
  )).toBe(6_020);
});

test('compaction ordering uses the invocation boundary even when clocks or settlement order differ', async () => {
  const { latestContextTokens } = await import('../../src/runtime/compaction.ts');
  const compaction = { timestamp: 200, data: JSON.stringify({ tokensAfter: 25_177, completionSequence: 5 }) };
  const usage = JSON.stringify({ input: 496_000, output: 869 });
  expect(latestContextTokens([{ usage, settledAt: 300, sequence: 5 }], compaction)).toBe(25_177);
  expect(latestContextTokens([{ usage, settledAt: 100, sequence: 6 }], compaction)).toBe(496_869);
});

test('the current schema tags every invocation with a purpose and keeps completion as the default', async () => {
  const root = await temp('schema');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  const columns = store.db.prepare('PRAGMA table_info(invocations)').all() as { name: string; dflt_value: string | null }[];
  expect(columns.find(column => column.name === 'purpose')).toMatchObject({ dflt_value: "'completion'" });
});

async function nativeWorker(runtime: Awaited<ReturnType<typeof openTaskRuntime>>, taskId: string) {
  await runtime.supervisor(taskId).propose({ requirementVersion: 1, summary: 'Compaction',
    acceptance: [{ id: 'ok', description: 'User inspects the response', checkNode: 'work' }],
    definition: parseGraphDefinition({ schemaVersion: 2, name: 'Compaction', protocols: { job: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Respond to this task.',
        inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } }, modules: {}, edges: {},
      acceptance: [{ id: 'ok', description: 'User inspects the response', kind: 'human' }] }),
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.supervisor(taskId).graphSend({ graphId: taskId, nodeId: 'work', input: 'job', value: {} });
}

test('a real auto-compaction is booked as its own invocation and keeps the original entries', async () => {
  const root = await temp('worker');
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const provider = await compactionProvider(({ summary }) => summary
    ? { text: '## Goal\ncompacted worker context', usage: { prompt_tokens: 900, completion_tokens: 30 } }
    // The completion reports a context past the small window's threshold and
    // answers with enough real text for Pi to find a cut point.
    : { text: LONG_TEXT, usage: { prompt_tokens: 2_000, completion_tokens: 40 } });
  const options = {
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    actions: {},
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
  };
  let runtime = await openTaskRuntime(options);
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Compaction', requestId: 'begin' });
  await nativeWorker(runtime, taskId);
  await runtime.host.drive();

  const view = runtime.nodeRun(taskId, 'work');
  const rows = view.invocations;
  const compaction = rows.filter(row => row.purpose === 'compaction');
  expect(compaction.length).toBeGreaterThanOrEqual(1);
  expect(rows.some(row => row.purpose === 'completion')).toBe(true);
  for (const row of compaction) {
    expect(row.usage).not.toBeNull();
    expect(row.cost).toMatchObject({ amount: 930 / 1_000_000 });
    expect(row.model).toBe('local');
  }
  // Every invocation counts once into the instance total.
  const invocationTokens = rows.reduce((sum, row) => sum + (row.usage ? tokenUsageTotal(row.usage as TokenUsage) : 0), 0);
  expect(view.instance?.used).toBe(invocationTokens);
  // The summary is a separate line and the original worker entry is still there.
  expect(view.invocations.filter(invocation => invocation.purpose === 'compaction').length).toBe(compaction.length);
  expect(view.entries.some(entry => entry.kind === 'compaction')).toBe(true);
  expect(view.entries.some(entry => entry.role === 'assistant' && entry.text.includes('worker keeps going'))).toBe(true);
  // Pi drops nothing from the Graph ledger: history only grows.
  expect(view.entryCount).toBe(view.entries.length);
  await runtime.close();
  options.models.entries[0]!.cost = { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 };
  runtime = await openTaskRuntime(options);
  const restored = await runtime.nodeRun(taskId, 'work');
  expect(restored.invocations).toEqual(view.invocations);
  expect(restored.entries).toEqual(view.entries);
});

test('a long turn books every durable compaction invocation and preserves the user conversation', async () => {
  const root = await temp('split');
  const provider = await compactionProvider(({ summary, index }) => {
    if (summary) return { text: '## Goal\nsummary part', usage: { prompt_tokens: 700, completion_tokens: 20 } };
    // First chat turn stays below the threshold; the second blows past it with
    // a reply big enough that the cut lands mid-turn (split turn).
    return index === 0 ? { text: '第一轮回复', usage: { prompt_tokens: 50, completion_tokens: 10 } } : { text: LONG_TEXT, usage: { prompt_tokens: 2_000, completion_tokens: 40 } };
  });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: '第一轮：先聊一下。', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.chat(created.conversationId, { text: '第二轮：继续。', requestId: 'chat' });
  await runtime.host.runReady();

  const summaries = provider.requests.filter(request => request.summary).length;
  expect(summaries).toBe(1);
  const compaction = purposes(root).filter(row => row.purpose === 'compaction');
  expect(compaction).toHaveLength(summaries);
  // Every summary call are charged exactly once into the instance total.
  expect(instanceTotals(root).every(instance => instance.used === instance.expected)).toBe(true);
  console.log(`[compaction-fixture] split-turn requests=${provider.requests.length} summaries=${provider.requests.filter(request => request.summary).length} purposes=${JSON.stringify(purposes(root).map(row => row.purpose))}`);
  // Chatting has no node entry surface, so history must survive in the message table.
  const view = await runtime.conversations.view(created.conversationId);
  const texts = view.messages.filter(message => message.role === 'user').map(message => message.text);
  expect(texts).toEqual(['第一轮：先聊一下。', '第二轮：继续。']);
  expect(view.messages.some(message => message.text === '第一轮回复')).toBe(true);
});

async function workerRuntime(root: string, provider: Awaited<ReturnType<typeof compactionProvider>>, extra: { defaultBudgetTokens?: number; modelId?: string } = {}) {
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    actions: {},
    models: { entries: [modelEntry(provider.baseUrl, extra.modelId)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    ...(extra.defaultBudgetTokens !== undefined ? { limits: { defaultBudgetTokens: extra.defaultBudgetTokens } } : {}),
  });
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Compaction gate', requestId: 'begin' });
  await nativeWorker(runtime, taskId);
  return { runtime, taskId };
}

test('a finite budget can refuse the summary even when the turn itself fit', async () => {
  const root = await temp('budget');
  const provider = await compactionProvider(({ summary }) => summary
    ? { text: 'must not be sent' }
    // Billing leaves sixty tokens in the already-declared quota. The summary
    // needs at least the model's 256-token output reservation, so it cannot fit.
    : { text: LONG_TEXT, usage: { prompt_tokens: 199_900, completion_tokens: 40 } });
  const { runtime, taskId } = await workerRuntime(root, provider, { defaultBudgetTokens: 200_000 });
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
  expect(provider.requests.filter(request => request.summary)).toHaveLength(0);
  const view = runtime.nodeRun(taskId, 'work');
  expect(view.invocations.filter(invocation => invocation.purpose === 'compaction')).toEqual([]);
  expect(view.invocations).toMatchObject([{ purpose: 'completion', state: 'settled', usage: { input: 199_900, output: 40 } }]);
  expect(view.instance?.used).toBe(199_940);
  const failed = runtime.events(taskId, 0).filter(event => event.type === 'session.compaction_failed');
  expect(failed).toMatchObject([{ data: { nodeId: 'work' } }]);
  const refused = runtime.events(taskId, 0).filter(event => event.type === 'graph.provider.refused');
  expect(refused.length).toBeGreaterThan(0);
  for (const event of refused) expect(event.data).toMatchObject({ nodeId: 'work', purpose: 'compaction', code: 'budget', reason: expect.stringMatching(/budget/i) });
  await runtime.sendNodeMessage(taskId, 'work', { text: 'Continue within the same quota.', requestId: 'follow-up' });
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
  expect(runtime.nodeRun(taskId, 'work').node.status).toBe('blocked');
}, 60_000);

test('a native summary without usage keeps the input and blocks further sends', async () => {
  const root = await temp('unknown');
  const provider = await compactionProvider(({ summary }) => summary
    ? { text: '## Goal\nno usage here', usage: null }
    : { text: LONG_TEXT, usage: { prompt_tokens: 2_000, completion_tokens: 40 } });
  const { runtime, taskId } = await workerRuntime(root, provider, { defaultBudgetTokens: 20_000_000 });
  await runtime.host.drive();
  expect(provider.requests.filter(request => request.summary)).toHaveLength(1);
  const rows = runtime.nodeRun(taskId, 'work').invocations.filter(row => row.purpose === 'compaction');
  expect(rows).toHaveLength(1);
  expect(rows[0]!.usage).toBeNull();
  expect(rows[0]!.cost).toBeNull();
  expect(runtime.nodeRun(taskId, 'work').node.status).toBe('blocked');
  expect(await runtime.supervisor(taskId).graphInspect({ graphId: taskId, query: 'queue' })).toMatchObject({ items: [{ nodeId: 'work', state: 'queued' }] });
  // The hold stops the next send instead of letting Pi retry silently.
  const before = provider.requests.length;
  await runtime.host.drive();
  expect(provider.requests.length).toBe(before);
}, 60_000);

test('summary invocations keep the frozen upstream identity, not the connection id', async () => {
  const root = await temp('identity');
  const provider = await compactionProvider(({ summary }) => summary
    ? { text: '## Goal\ncompacted', usage: { prompt_tokens: 300, completion_tokens: 20 } }
    : { text: LONG_TEXT, usage: { prompt_tokens: 2_000, completion_tokens: 40 } });
  const { runtime, taskId } = await workerRuntime(root, provider, { modelId: 'original-model' });
  await runtime.host.drive();
  const rows = runtime.nodeRun(taskId, 'work').invocations;
  expect(rows.length).toBeGreaterThanOrEqual(2);
  expect(rows.some(row => row.purpose === 'compaction')).toBe(true);
  // R08: history keeps the upstream identity even for summarization sends.
  expect(rows.every(row => 'modelIdentity' in row && row.modelIdentity === 'original-model')).toBe(true);
  expect(rows.every(row => row.model === 'local')).toBe(true);
  expect(provider.requests.every(request => request.model === 'original-model')).toBe(true);
}, 60_000);

test('a pause during auto-compaction stops the summary request through the task gate', async () => {
  const root = await temp('pause');
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });
  let runtimeRef: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  let taskIdRef = '';
  const provider = await compactionProvider(({ summary }) => summary
    ? { text: 'should never be sent' }
    // Pause before answering the completion: by the time Pi checks the
    // threshold and starts compacting, the task is already paused, so the
    // summary must be refused by the same gate as a normal send.
    : { text: LONG_TEXT, usage: { prompt_tokens: 2_000, completion_tokens: 40 }, pause: async () => { await runtimeRef!.user.task(taskIdRef).pause('pause-during-compaction'); } });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: workspace }],
    actions: {},
    models: { entries: [modelEntry(provider.baseUrl)], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
  });
  cleanup.push(() => runtime.close());
  runtimeRef = runtime;
  await installPresets(runtime.catalog, presetsRoot);
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'Paused compaction', requestId: 'begin' });
  taskIdRef = taskId;
  await nativeWorker(runtime, taskId);
  await runtime.host.drive();

  expect(provider.requests.filter(request => request.summary)).toHaveLength(0);
  expect(provider.requests).toHaveLength(1);
  // The summary was attempted (Pi started compaction) but never sent.
  const events = new DatabaseSync(join(root, 'state', 'tasks.sqlite'));
  const started = (events.prepare("SELECT COUNT(*) AS count FROM events WHERE type='session.compaction_started'").get() as { count: number }).count;
  events.close();
  expect(started).toBeGreaterThanOrEqual(1);
  const view = runtime.nodeRun(taskId, 'work');
  expect(view.invocations.filter(invocation => invocation.purpose === 'compaction')).toEqual([]);
  const billed = view.invocations.filter(invocation => {
    const usage = invocation.usage as Record<string, number> | null;
    return usage !== null && (usage.input ?? 0) + (usage.output ?? 0) > 0;
  });
  expect(billed).toHaveLength(1);
  expect(await runtime.supervisor(taskId).graphInspect({ graphId: taskId })).toMatchObject({ phase: 'paused' });
  await runtime.host.drive();
  expect(provider.requests).toHaveLength(1);
}, 60_000);

test('post-turn compaction remains newer than the completion when the operation settles later', async () => {
  const root = await temp('post-turn-clock');
  const provider = await compactionProvider(({ summary, index }) => summary
    ? { text: '## Goal\nKeep working on the next user request.', usage: { prompt_tokens: 900, completion_tokens: 30 } }
    : index === 0
      ? { text: LONG_TEXT.repeat(4), usage: { prompt_tokens: 8_000, completion_tokens: 40 } }
      : { text: 'Continued without redundant compaction.', usage: { prompt_tokens: 40, completion_tokens: 10 } });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: { entries: [{ ...modelEntry(provider.baseUrl), contextWindow: 8_192 }], apiKey: 'local-key', modelRuntime: provider.modelRuntime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ text: 'Prepare history.', requestId: 'create' });
  await runtime.host.runReady();
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  cleanup.push(() => db.close());
  const before = db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='session.compaction_started'").get() as { count: number };
  expect(before.count).toBe(1);
  // The next turn must use the compacted context, not the large billed context
  // whose containing operation was settled after the summary was stored.
  await runtime.conversations.chat(created.conversationId, { text: 'Continue the work.', requestId: 'continue' });
  await runtime.host.runReady();
  expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='session.compaction_started'").get()).toEqual(before);
  expect((await runtime.conversations.view(created.conversationId)).messages.some(message => message.text === 'Continued without redundant compaction.')).toBe(true);
  // Manual compaction may have nothing left to shorten. Neither that case nor
  // a repeated compact command is an execution failure or a parked master.
  await runtime.conversations.compact(created.conversationId, { requestId: 'compact-1' });
  await runtime.host.runReady();
  await runtime.conversations.compact(created.conversationId, { requestId: 'compact-2' });
  await runtime.host.runReady();
  expect(db.prepare("SELECT kind FROM questions WHERE status='open'").all()).toEqual([]);
  expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='session.compaction_failed'").get()).toEqual({ count: 0 });
}, 60_000);
