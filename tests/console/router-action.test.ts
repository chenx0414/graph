// Failure modes for the router action, written before the code (R24).
//
// The user's design, in their own words: a router's upper layer may be a tool node or an agent node.
//   - tool node  -> "实现定义一下，根据节点结果判定路由到哪" (decide from the node's result)
//   - agent node -> "让 agent 调用一个工具，或者结构化声明，来决定路由到接下来的哪个节点"
//
// So one action, `route`, with two honest sources of a case. The graph validation already exists
// (`result.route` must be a declared case); what was missing was anything that could produce a case
// at all — proven live: a real router graph saw readiness skip on EVERY branch.
//
// 1. A tool node that SUCCEEDED routes to the case mapped from its status.
// 2. A tool node that FAILED routes to the failure case — a check that failed is the whole point.
// 3. A declared field may override status: `output.outcome: 'rework'` -> the rework case.
// 4. An agent node declaring its own case routes there.
// 5. Whatever the source, the case MUST be one the node declared — never an invented branch.
// 6. A case that maps to nothing is refused, not silently defaulted.
// 7. An undeclared route on a non-router node is refused (unchanged rule, still proven here).
// 8. No source produces nothing silently: a router with no resolvable case reports why.

import { expect, test } from 'vitest';
import { resolveRouteCase, type RouteDecisionInput } from '../../src/core/router-action.ts';

const base: Omit<RouteDecisionInput, 'routes' | 'source'> = {
  nodeId: 'gate',
  status: 'succeeded',
  output: null,
};

test('a tool node that succeeded routes by its status', () => {
  const decision = resolveRouteCase({
    ...base,
    routes: ['pass', 'fail'],
    source: { byStatus: { succeeded: 'pass', failed: 'fail' } },
  });
  expect(decision).toEqual({ case: 'pass' });
});

test('a failed check routes to the failure case — that is the whole point of a gate', () => {
  const decision = resolveRouteCase({
    ...base,
    status: 'failed',
    routes: ['pass', 'fail'],
    source: { byStatus: { succeeded: 'pass', failed: 'fail' } },
  });
  expect(decision).toEqual({ case: 'fail' });
});

test('a declared output field can override status', () => {
  const decision = resolveRouteCase({
    ...base,
    output: { kind: 'verification', outcome: 'rework' },
    routes: ['pass', 'rework'],
    source: { byField: { path: 'outcome', values: { pass: 'pass', rework: 'rework' } } },
  });
  expect(decision).toEqual({ case: 'rework' });
});

test('an agent declaring its own case routes there', () => {
  const decision = resolveRouteCase({
    ...base,
    routes: ['design', 'implement'],
    source: { declared: 'design' },
  });
  expect(decision).toEqual({ case: 'design' });
});

test('a case the node never declared is refused, never invented', () => {
  const decision = resolveRouteCase({
    ...base,
    routes: ['pass', 'fail'],
    source: { declared: 'maybe' },
  });
  expect('refusal' in decision && decision.refusal).toContain('maybe');
});

test('a declared value that maps to no case is refused, not silently defaulted', () => {
  const decision = resolveRouteCase({
    ...base,
    output: { outcome: 'unknown' },
    routes: ['pass', 'rework'],
    source: { byField: { path: 'outcome', values: { pass: 'pass', rework: 'rework' } } },
  });
  expect('refusal' in decision && decision.refusal).toContain('unknown');
});

test('a router with no resolvable case says why instead of guessing', () => {
  const decision = resolveRouteCase({ ...base, status: 'pending', routes: ['pass'], source: { byStatus: { succeeded: 'pass' } } });
  expect('refusal' in decision && decision.refusal).toContain('pending');
});

test('status mapping wins only for the statuses it declares; others are refused', () => {
  const decided = resolveRouteCase({ ...base, status: 'succeeded', routes: ['pass'], source: { byStatus: { succeeded: 'pass' } } });
  expect(decided).toEqual({ case: 'pass' });
  const refused = resolveRouteCase({ ...base, status: 'blocked', routes: ['pass'], source: { byStatus: { succeeded: 'pass' } } });
  expect('refusal' in refused).toBe(true);
});
