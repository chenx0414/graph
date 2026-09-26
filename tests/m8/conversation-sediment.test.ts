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
    body: '## 步骤\n\n1. 数这个操作自己的工具调用，而不是统计表里的行。\n',
  });
  // The cheap model answers two separate one-shot calls per turn (the composer suggestion, then the
  // review), so it needs a plan for each; both are the proposal, which keeps the order irrelevant.
  const reader = await openaiServer([{ text: proposal }, { text: proposal }]);
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
  expect(JSON.parse(recorded[0]!.data)).toMatchObject({ reviewed: true, proposed: null, written: [], refused: [] });
}, 120_000);
