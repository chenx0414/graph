// Failure modes the card projection must survive, written before the code:
// 1. Task still running          -> no card at all (nothing has ended to report).
// 2. Cost never recorded         -> tokens unknown, never a confident 0.
// 3. Abandoned task              -> shown, but labelled as stopped, never "delivered".
// 4. Completed with no sha       -> an ending without a handover, not a delivery.
// 5. Acceptance evidence partial -> only the checks that passed are listed.

import { expect, test } from 'vitest';
import { taskCard, type CardTask } from '../../src/web/task-card.ts';

function task(over: Partial<CardTask> = {}): CardTask {
  return {
    id: 't1', request: 'ship it', phase: 'completed', status: 'completed',
    integrationSha: 'sha-1', targetBranch: 'main',
    cost: { amount: 0.5 },
    nodes: [{ id: 'build', status: 'succeeded' }, { id: 'check', status: 'succeeded' }],
    evidence: [{ acceptanceId: 'acc-1', valid: true }, { acceptanceId: 'acc-2', valid: false }],
    ...over,
  };
}

test('a running task has no card: nothing has ended yet', () => {
  expect(taskCard(task({ phase: 'running', status: 'running', integrationSha: null }))).toBeNull();
});

test('a delivered task names its result, handover and passing checks', () => {
  const card = taskCard(task())!;
  expect(card.outcome).toBe('delivered');
  expect(card.outcomeLabel).toBe('已交付');
  expect(card.delivery).toMatchObject({ integrationSha: 'sha-1', targetBranch: 'main' });
  // Only checks that passed are listed; a failed one is not dressed up as acceptance.
  expect(card.delivery!.acceptance).toEqual(['acc-1']);
});

test('cost that was never recorded stays unknown instead of showing 0', () => {
  const card = taskCard(task({ cost: {} }))!;
  expect(card.usage.tokens).toBeNull();
  // Reuse the console's existing wording rather than inventing a second one for the same fact.
  expect(card.usage.costText).toBe('无记录');
  expect(card.usage.tokensText).toBe('未知');
});

test('tokens come from the usage the nodes actually reported', () => {
  const card = taskCard(task({ nodes: [{ id: 'build', status: 'succeeded', used: 900 }, { id: 'check', status: 'succeeded', used: 300 }] }))!;
  expect(card.usage.tokens).toBe(1200);
  expect(card.usage.tokensText).toBe('1,200');
});

test('one node with no recorded usage leaves the total unknown, not short', () => {
  const card = taskCard(task({ nodes: [{ id: 'build', status: 'succeeded', used: 900 }, { id: 'check', status: 'succeeded', used: null }] }))!;
  expect(card.usage.tokens).toBe(900);
});

test('a user stop is reported as stopped, never as a delivery', () => {
  const card = taskCard(task({ phase: 'abandoned', status: 'abandoned', integrationSha: null }))!;
  expect(card.outcome).toBe('stopped');
  expect(card.outcomeLabel).toBe('已中止');
  expect(card.delivery).toBeNull();
});

test('a completed task with no handover sha is not called delivered', () => {
  const card = taskCard(task({ integrationSha: null }))!;
  expect(card.outcome).toBe('unfinished');
  expect(card.delivery).toBeNull();
});

test('the node breakdown keeps every node and its status in order', () => {
  const card = taskCard(task())!;
  expect(card.nodes.map(node => `${node.id}:${node.status}`)).toEqual(['build:succeeded', 'check:succeeded']);
});
