import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { git } from '../../src/git/git.ts';
import { RsiService } from '../../src/runtime/rsi.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/**
 * An activation turn is where the most real work happens, and it is also the one turn with no
 * assistant reply at all: after the change is applied the model is never asked again, so there is no
 * final text to review. The turn used to return at the reload receipt, which meant the review never
 * ran on it. It now runs — and it has to read the change, not the receipt.
 */
test('a turn that applied and activated a change is reviewed on the change itself', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rsi-sediment-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const checkout = join(root, 'checkout');
  await mkdir(checkout);
  await writeFile(join(checkout, 'package.json'), '{"name":"graph"}\n');
  for (const args of [['init', '-b', 'main'], ['add', '-A'], ['commit', '-m', 'init']]) {
    expect(git(checkout, args).code).toBe(0);
  }
  const stateDir = join(root, 'state');
  const rsi = new RsiService({ root: checkout, stateDir, validate: async () => [{ command: 'fixture check', status: 'passed', output: '' }] });
  const provider = await openaiServer([{
    tools: [{
      id: 'apply',
      name: 'apply_rsi_change',
      arguments: JSON.stringify({
        title: 'First improvement',
        problem: 'The harness needed a helper for the thing it kept doing by hand',
        activate: true,
        changes: [{ path: 'helper.ts', action: 'write', content: 'export const helper = 1;\n' }],
      }),
    }],
  }]);
  const reader = await openaiServer([
    { text: '{"action":"nothing","id":"x","reason":"nothing transferable"}' },
    { text: '{"action":"nothing","id":"x","reason":"nothing transferable"}' },
  ]);
  cleanup.push(() => provider.close());
  cleanup.push(() => reader.close());
  const entries = [
    { ...provider.model, id: 'local', grade: 'high' as const, credentialId: 'local' },
    { ...reader.model, id: 'reader-model', grade: 'low' as const, credentialId: 'reader' },
  ];
  const runtime = await openTaskRuntime({
    stateDir, rsi, access: () => fullAccessPolicy(),
    projects: [{ id: 'p', root: checkout }],
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    models: { entries, apiKey: 'local-key', credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }), modelRuntime: provider.runtime },
    live: {
      revision: () => 1,
      // The switch on, at the lowest threshold: any turn with a tool call earns a review, and this turn
      // has one — the apply itself.
      config: () => ({ skills: { sedimentation: { enabled: true, afterToolCalls: 1, model: 'reader-model', budgetTokens: 40_000 } } }),
      entries: () => entries,
      preferences: () => ({}),
      credentialFor: entry => ({ credentialId: entry.id, apiKey: 'k' }),
      masterModel: () => 'local',
      defaultBudgetTokens: () => null,
      projects: () => [{ id: 'p', root: checkout }],
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');
  const created = await runtime.conversations.create({ projectId: 'p', text: 'Prepare.', requestId: 'create' });
  await runtime.host.runReady();
  await runtime.conversations.chat(created.conversationId, { text: 'Improve the harness and activate it.', requestId: 'improve' });
  await runtime.host.runReady();

  const decided = new DatabaseSync(join(stateDir, 'tasks.sqlite'))
    .prepare("SELECT data FROM events WHERE type = 'skill_sediment.reviewed'").all() as { data: string }[];
  expect(decided).toHaveLength(1);
  expect(JSON.parse(decided[0]!.data)).toMatchObject({ reviewed: true, proposed: 'nothing' });
  // The review has to be asked about the change — its title, why it was needed, what files moved.
  // A receipt-shaped material would carry none of that.
  expect(reader.requests).toHaveLength(1);
  const asked = JSON.stringify(reader.requests[0]);
  expect(asked).toContain('First improvement');
  expect(asked).toContain('The harness needed a helper for the thing it kept doing by hand');
  expect(asked).toContain('helper.ts');
}, 60_000);
