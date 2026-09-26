import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * One turn, one composer suggestion. The suggestion is a one-shot call on a cheaper model, and it used
 * to swallow every outcome into `undefined`: a provider that refused and a model that simply had
 * nothing to suggest were the same fact from the outside. These turns pin the difference down in the
 * same record the review already writes.
 */
async function runTurn(input: { requestId: string; suggestion: { status?: number; error?: string; text?: string }[] }) {
  const root = await mkdtemp(join(tmpdir(), 'suggestion-turn-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.agents', 'skills'), { recursive: true });
  const main = await openaiServer([{ text: '这一轮做完了。' }]);
  const suggestion = await openaiServer(input.suggestion);
  cleanup.push(() => main.close());
  cleanup.push(() => suggestion.close());
  const entries = [
    { id: 'main-model', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: main.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
    { id: 'cheap-model', provider: 'graph-openai', grade: 'low' as const, api: 'openai-completions' as const, baseUrl: suggestion.model.baseUrl, contextWindow: 32_000, maxTokens: 256 },
  ];
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], actions: {},
    models: { entries, credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: main.runtime },
    live: {
      revision: () => 1,
      // Sedimentation stays off: this turn is about the suggestion's own record.
      config: () => ({}),
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
  await runtime.conversations.create({ projectId: 'p', text: '做一件事。', requestId: input.requestId });
  await runtime.host.runReady();
  const recorded = new DatabaseSync(join(root, 'state', 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'prompt_suggestion.decided'").all() as { data: string }[];
  return recorded.map(row => JSON.parse(row.data) as {
    model: string | null; asked: boolean; stopReason: string | null; error: string | null; chars: number; suggestion: string;
  });
}

test('a suggestion call that fails is recorded with its reason', async () => {
  // Enough failing plans that a transport retry cannot reach the fixture's fallback text: every
  // request this call makes has to come back as an error.
  const decisions = await runTurn({
    requestId: 'suggestion-error',
    suggestion: Array.from({ length: 6 }, () => ({ status: 500, error: 'the suggestion provider exploded' })),
  });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ asked: true, model: 'cheap-model', suggestion: '' });
  expect(decisions[0]!.error).toMatch(/exploded|500/);
}, 120_000);

test('a model with nothing to suggest is recorded as a decision, not as a failure', async () => {
  const decisions = await runTurn({ requestId: 'suggestion-none', suggestion: [{ text: '没有建议' }, { text: '没有建议' }] });
  expect(decisions).toHaveLength(1);
  expect(decisions[0]).toMatchObject({ asked: true, stopReason: 'stop', error: null, suggestion: '' });
}, 120_000);
