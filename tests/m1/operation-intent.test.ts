import { expect, test } from 'vitest';
import { operationIntentEvent } from '../../src/core/operation-lifecycle.ts';
import type { Operation } from '../../src/core/types.ts';
import { buildTimeline } from '../../src/web/insights.ts';

/** A spec big enough that duplicating it in the event log is the bug under test. */
const operation = {
  id: 'op-1', taskId: 'task-1', nodeId: 'master', instanceId: 'instance-1', generation: 3, attempt: 2,
  kind: 'agent', action: 'master', proposalVersion: 1, requirementVersion: 11,
  input: { request: 'x'.repeat(200_000) },
  dependencies: { previous: 'z'.repeat(20_000) },
  context: { previousOutput: null, answers: [], briefing: 'y'.repeat(50_000) },
} as unknown as Operation;

test('an intent event points at the operation row instead of duplicating its spec', () => {
  const data = operationIntentEvent(operation);
  expect(data).toMatchObject({
    operationId: 'op-1', taskId: 'task-1', nodeId: 'master', instanceId: 'instance-1',
    generation: 3, attempt: 2, kind: 'agent', action: 'master', specRef: 'operations.spec',
  });

  // The heavy parts stay in the row, so the event stays small even when the spec is not.
  const encoded = JSON.stringify(data);
  expect(encoded.length).toBeLessThan(600);
  expect(encoded).not.toContain('xxxx');
  expect(encoded).not.toContain('yyyy');
  expect(encoded).not.toContain('zzzz');
  expect(data).not.toHaveProperty('input');
  expect(data).not.toHaveProperty('dependencies');
  expect(data).not.toHaveProperty('context');
});

test('the timeline still identifies the operation from that reference', () => {
  const events = [{
    cursor: 1, taskId: 'task-1', type: 'operation.intent',
    data: operationIntentEvent(operation), timestamp: 0,
  }] as unknown as Parameters<typeof buildTimeline>[0];
  const [entry] = buildTimeline(events);
  expect(entry?.detail).toBe('op-1');
  expect(entry?.tone).toBe('active');
});
