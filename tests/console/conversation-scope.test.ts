// Failure modes this same-graph reach must survive, written before any code (R24).
//
// The decision (user, 2026-09-28): subagents of one graph may talk to each other — and to nobody
// else. That single constraint is what replaces the chain/ceiling guards the user removed from the
// cross-conversation path: a subagent cannot command another graph because it cannot name one.
//
// 1. Worker in graph A addresses a node of graph B  -> refused. This is the whole point.
// 2. Worker addresses a node of its OWN graph      -> allowed.
// 3. Worker addresses its own node                 -> refused (nothing to say to itself).
// 4. Main, which legitimately reaches any conversation, is NOT narrowed by this rule.
// 5. A node id that does not exist in the named graph -> refused, not silently accepted.
// 6. A target task that does not exist                -> refused.
// 7. Reach is a property of the caller, not of the text: a worker must not be able to escape its
//    graph by phrasing the message differently, so the check lives on the resolved target task.

import { expect, test } from 'vitest';
import { sameGraphReach } from '../../src/runtime/conversation-scope.ts';

test('a worker reaches a peer in its own graph', () => {
  expect(sameGraphReach({ callerTask: 'graph-a', callerNode: 'build', targetTask: 'graph-a', targetNode: 'check' })).toBeNull();
});

test('a worker cannot reach another graph — the constraint that replaces the removed guards', () => {
  const refusal = sameGraphReach({ callerTask: 'graph-a', callerNode: 'build', targetTask: 'graph-b', targetNode: 'build' });
  expect(refusal).toBeTruthy();
  // The refusal has to name the rule, or the model will retry the same call forever.
  expect(refusal).toContain('同一张图');
});

test('a worker cannot address its own node', () => {
  expect(sameGraphReach({ callerTask: 'graph-a', callerNode: 'build', targetTask: 'graph-a', targetNode: 'build' })).toContain('自己');
});

test('a target node that is not in the named graph is refused, never silently accepted', () => {
  const refusal = sameGraphReach({ callerTask: 'graph-a', callerNode: 'build', targetTask: 'graph-a', targetNode: 'ghost', knownNodes: ['build', 'check'] });
  expect(refusal).toContain('ghost');
});

test('a target task that does not exist is refused', () => {
  const refusal = sameGraphReach({ callerTask: 'graph-a', callerNode: 'build', targetTask: 'missing', targetNode: 'check', knownTasks: ['graph-a'] });
  expect(refusal).toBeTruthy();
});
