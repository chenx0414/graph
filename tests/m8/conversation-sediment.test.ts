import { afterEach, expect, test } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// The review is there to catch what an operation earned, so it must decide on what that operation
// itself did. A worker lane only reaches the `tool_calls` table when a console page is read — the
// ingest runs on demand — so counting rows there would leave a fresh conversation silently
// unreviewed, which is exactly the failure this turn pins down.
test('an operation that did the work writes its own skill, without anybody reading the statistics', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sediment-turn-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.agents', 'skills'), { recursive: true });
  const main = await openaiServer([
    { tools: [{ id: 'call-1', name: 'bash', arguments: '{"command":"echo one"}' }] },
    { tools: [{ id: 'call-2', name: 'bash', arguments: '{"command":"echo two"}' }] },
    { text: '这次的结论：数操作自己的工具调用。' },
  ]);
  const proposal = JSON.stringify({
    action: 'create',
    id: 'count-own-work',
    description: 'Use when a review must decide whether one operation earned a skill',
    reason: 'the review learned how the count is taken',
  });
  const reply = `${proposal}\n\`\`\`markdown\n## 步骤\n\n1. 数这个操作自己的工具调用，而不是统计表里的行。\n\`\`\``;
  // The cheap model answers two separate one-shot calls per turn (the composer suggestion, then the
  // review), so it needs a plan for each; both are the proposal, which keeps the order irrelevant.
  const reader = await openaiServer([{ text: reply }, { text: reply }]);
  cleanup.push(() => main.close());
  cleanup.push(() => reader.close());
  const entries = [
    { id: 'main-model', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: main.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'reader-model', provider: 'graph-openai', grade: 'low' as const, api: 'openai-completions' as const, baseUrl: reader.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    models: {
      entries,
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      modelRuntime: main.runtime,
    },
    live: {
      revision: () => 1,
      // The switch turned on the way the document turns it on, so this test also fails if the
      // parser stops carrying the block.
      config: () => ({ skills: { sedimentation: { enabled: true, afterToolCalls: 2, model: 'reader-model', budgetTokens: 40_000 } } }),
      entries: () => entries,
      preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'main-model',
      defaultBudgetTokens: () => null,
      projects: () => [{ id: 'p', root: project }],
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
  });
  cleanup.push(() => runtime.close());
  const created = await runtime.conversations.create({ projectId: 'p', text: '请做两步检查，然后总结。', requestId: 'sediment-turn' });

  await runtime.host.runReady();

  const written = join(project, '.agents', 'skills', 'count-own-work', 'SKILL.md');
  expect(existsSync(written)).toBe(true);
  const text = readFileSync(written, 'utf8');
  expect(text).toContain('created-by: graph-agent');
  expect(text).toContain('数这个操作自己的工具调用');
  // The review is the call that carried this operation's own material: what the user asked, what the
  // Agent answered, and the skills that already exist.
  const review = reader.requests.map(request => JSON.stringify(request)).find(request => request.includes('existingSkills'));
  expect(review).toBeTruthy();
  expect(review).toContain('数操作自己的工具调用');
  // A decision nobody can read is not a fact. The review records what it decided and what it wrote,
  // so "did it run, and what came of it" is answerable from the store instead of by guessing.
  const recorded = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'skill_sediment.reviewed'").all() as { data: string }[];
  expect(recorded).toHaveLength(1);
  const decision = JSON.parse(recorded[0]!.data) as { reviewed: boolean; proposed: string; written: { id: string }[] };
  expect(decision).toMatchObject({ reviewed: true, proposed: 'create' });
  expect(decision.written.map(entry => entry.id)).toEqual(['count-own-work']);
}, 120_000);

// A reply that carries no proposal is a real outcome, and it is not the same as an empty one: the
// record has to say the review ran and found nothing readable, or a silent failure looks identical.
test('a review whose reply carries no proposal is recorded as such and writes nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sediment-nothing-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.agents', 'skills'), { recursive: true });
  const main = await openaiServer([
    { tools: [{ id: 'call-1', name: 'bash', arguments: '{"command":"echo one"}' }] },
    { tools: [{ id: 'call-2', name: 'bash', arguments: '{"command":"echo two"}' }] },
    { text: '这次没有可沉淀的东西。' },
  ]);
  const reader = await openaiServer([{ text: '我看了，没什么值得记的。' }, { text: '我看了，没什么值得记的。' }]);
  cleanup.push(() => main.close());
  cleanup.push(() => reader.close());
  const entries = [
    { id: 'main-model', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: main.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'reader-model', provider: 'graph-openai', grade: 'low' as const, api: 'openai-completions' as const, baseUrl: reader.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    models: { entries, credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: main.runtime },
    live: {
      revision: () => 1,
      config: () => ({ skills: { sedimentation: { enabled: true, afterToolCalls: 2, model: 'reader-model', budgetTokens: 40_000 } } }),
      entries: () => entries,
      preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'main-model',
      defaultBudgetTokens: () => null,
      projects: () => [{ id: 'p', root: project }],
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
  });
  cleanup.push(() => runtime.close());
  await runtime.conversations.create({ projectId: 'p', text: '做两步检查。', requestId: 'sediment-nothing' });
  await runtime.host.runReady();

  expect(readdirSync(join(project, '.agents', 'skills'))).toEqual([]);
  const recorded = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'skill_sediment.reviewed'").all() as { data: string }[];
  expect(recorded).toHaveLength(1);
  const decision = JSON.parse(recorded[0]!.data) as {
    reviewed: boolean; proposed: string | null; written: unknown[]; refused: unknown[];
    replyStop: string | null; replyChars: number; replyHead: string;
  };
  expect(decision).toMatchObject({ reviewed: true, proposed: null, written: [], refused: [] });
  // "Nothing readable came back" has to be diagnosable from the record alone: the stop reason, how
  // long the reply was, and how it began. Without those, a broken call and a rambling model look
  // exactly the same, and the whole feature can only be described as "it ran and did nothing".
  expect(decision.replyStop).toBe('stop');
  expect(decision.replyChars).toBeGreaterThan(0);
  expect(decision.replyHead).toContain('没什么值得记的');
}, 120_000);

// A review call that fails is the case that actually kept the feature quiet in production: the call
// errored, `proposed` came back null, and the record said nothing about why. The reason has to be
// part of the record, or a broken provider is indistinguishable from a model with nothing to say.
test('a failed review call is recorded with its reason instead of as a silent nothing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sediment-error-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.agents', 'skills'), { recursive: true });
  const main = await openaiServer([
    { tools: [{ id: 'call-1', name: 'bash', arguments: '{"command":"echo one"}' }] },
    { tools: [{ id: 'call-2', name: 'bash', arguments: '{"command":"echo two"}' }] },
    { text: '两步都做完了。' },
  ]);
  const reader = await openaiServer([
    { status: 500, error: 'the review provider exploded' },
    { status: 500, error: 'the review provider exploded' },
  ]);
  cleanup.push(() => main.close());
  cleanup.push(() => reader.close());
  const entries = [
    { id: 'main-model', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: main.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'reader-model', provider: 'graph-openai', grade: 'low' as const, api: 'openai-completions' as const, baseUrl: reader.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    models: { entries, credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: main.runtime },
    live: {
      revision: () => 1,
      config: () => ({ skills: { sedimentation: { enabled: true, afterToolCalls: 2, model: 'reader-model', budgetTokens: 40_000 } } }),
      entries: () => entries,
      preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'main-model',
      defaultBudgetTokens: () => null,
      projects: () => [{ id: 'p', root: project }],
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
  });
  cleanup.push(() => runtime.close());
  await runtime.conversations.create({ projectId: 'p', text: '做两步检查。', requestId: 'sediment-error' });
  await runtime.host.runReady();

  expect(readdirSync(join(project, '.agents', 'skills'))).toEqual([]);
  const recorded = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'skill_sediment.reviewed'").all() as { data: string }[];
  expect(recorded).toHaveLength(1);
  const decision = JSON.parse(recorded[0]!.data) as { reviewed: boolean; proposed: string | null; replyStop: string | null; replyError: string | null };
  expect(decision).toMatchObject({ reviewed: true, proposed: null, written: [], refused: [] });
  expect(decision.replyError).toBeTruthy();
  expect(decision.replyError).toMatch(/exploded|500/);
}, 120_000);

// A review is a small call on a cheap model, and a cheap model is exactly the one whose account can be
// out of quota. That must not be the end of the answer: ask the next candidate before giving up, and
// keep every attempt in the record so a silent single failure can never look like a decision.
test('a review survives one cheap model refusing it by asking the next one', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sediment-failover-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.agents', 'skills'), { recursive: true });
  const main = await openaiServer([
    { tools: [{ id: 'call-1', name: 'bash', arguments: '{"command":"echo one"}' }] },
    { tools: [{ id: 'call-2', name: 'bash', arguments: '{"command":"echo two"}' }] },
    { text: '两步都做完了。' },
  ]);
  // An account that is out of quota answers with nothing at all — a 429 the transport may retry, then
  // empty replies. Either way the review must not stop there, so the plans below are mostly empty and
  // there are enough of them to outlast the suggestion call's own retries.
  const outOfQuota = await openaiServer([
    { status: 429, error: 'quota exhausted' },
    { text: '' },
    { text: '' },
    { text: '' },
    { text: '' },
    { text: '' },
    { text: '' },
    { text: '' },
    { text: '' },
  ]);
  const healthy = await openaiServer(Array.from({ length: 8 }, () => ({ text: '{"action":"nothing","reason":"the operation restated what the repository already says"}' })));
  cleanup.push(() => main.close());
  cleanup.push(() => outOfQuota.close());
  cleanup.push(() => healthy.close());
  const entries = [
    { id: 'main-model', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: main.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'cheap-model', provider: 'graph-openai', grade: 'low' as const, api: 'openai-completions' as const, baseUrl: outOfQuota.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'next-model', provider: 'graph-openai', grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: healthy.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    models: { entries, credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: main.runtime },
    live: {
      revision: () => 1,
      config: () => ({ skills: { sedimentation: { enabled: true, afterToolCalls: 2, model: 'cheap-model', budgetTokens: 40_000 } } }),
      entries: () => entries,
      preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'main-model',
      defaultBudgetTokens: () => null,
      projects: () => [{ id: 'p', root: project }],
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
  });
  cleanup.push(() => runtime.close());
  await runtime.conversations.create({ projectId: 'p', text: '做两步检查。', requestId: 'sediment-failover' });
  await runtime.host.runReady();

  const recorded = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'skill_sediment.reviewed'").all() as { data: string }[];
  expect(recorded).toHaveLength(1);
  const decision = JSON.parse(recorded[0]!.data) as {
    reviewed: boolean; proposed: string | null; model: string; attempts: { model: string; error: string | null; chars: number }[];
  };
  // The configured model was asked first and gave nothing usable; the next one answered.
  expect(decision.attempts.map(attempt => attempt.model)).toEqual(['cheap-model', 'next-model']);
  expect(decision.model).toBe('next-model');
  expect(decision.proposed).toBe('nothing');
}, 120_000);

// The live failure behind HB-126: a 4,363-character reply whose metadata line was perfectly good was
// dropped as unreadable, because the markdown below it carried braces of its own and the parser took
// the last one as the end of the metadata. A body without a fence now reads as a body.
test('a reply whose body carries braces but no fence still writes the skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sediment-nofence-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.agents', 'skills'), { recursive: true });
  const main = await openaiServer([
    { tools: [{ id: 'call-1', name: 'bash', arguments: '{"command":"echo one"}' }] },
    { tools: [{ id: 'call-2', name: 'bash', arguments: '{"command":"echo two"}' }] },
    { text: '两步都做完了。' },
  ]);
  const reply = [
    '{"action":"create","id":"no-fence-body","description":"Use when a verdict arrives as one metadata line plus prose"}',
    '',
    '## 步骤',
    '',
    '1. 先读元数据行：`{"action":"create"}`。',
  ].join('\n');
  const reader = await openaiServer([{ text: reply }, { text: reply }]);
  cleanup.push(() => main.close());
  cleanup.push(() => reader.close());
  const entries = [
    { id: 'main-model', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: main.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'reader-model', provider: 'graph-openai', grade: 'low' as const, api: 'openai-completions' as const, baseUrl: reader.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    models: { entries, credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: main.runtime },
    live: {
      revision: () => 1,
      config: () => ({ skills: { sedimentation: { enabled: true, afterToolCalls: 2, model: 'reader-model', budgetTokens: 40_000 } } }),
      entries: () => entries,
      preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'main-model',
      defaultBudgetTokens: () => null,
      projects: () => [{ id: 'p', root: project }],
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
  });
  cleanup.push(() => runtime.close());
  await runtime.conversations.create({ projectId: 'p', text: '做两步检查。', requestId: 'sediment-nofence' });
  await runtime.host.runReady();

  const written = readFileSync(join(project, '.agents', 'skills', 'no-fence-body', 'SKILL.md'), 'utf8');
  expect(written).toContain('## 步骤');
  expect(written).toContain('{"action":"create"}');
  const recorded = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'skill_sediment.reviewed'").all() as { data: string }[];
  const decision = JSON.parse(recorded[0]!.data) as { proposed: string | null; replyShape: { metadataLine: boolean; fence: boolean; chars: number } };
  expect(decision.proposed).toBe('create');
  // The shape travels with the decision, so the next "unreadable" reply explains itself.
  expect(decision.replyShape).toMatchObject({ metadataLine: true, fence: false, chars: reply.length });
}, 120_000);
