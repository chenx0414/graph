// Failure modes for drawing conditional branches (R24), written before the code.
//
// The gap HB-182 found: `layoutGraph` receives nodes, containers and loops — but not the branch
// conditions the runtime actually uses, so "which case leads where" was invisible. `when` is
// already on the node, so the branches are derivable: this is a projection, not a new field.
//
// 1. A node gated by `when` gets an edge from its router, carrying the case it waits for.
// 2. That edge is distinguishable from a plain dependency edge — otherwise the picture lies.
// 3. A container's `when` counts too, or a gated branch group would be invisible.
// 4. A node with no `when` gets no branch edge — nothing is invented.
// 5. The branch edge exists IN ADDITION to the dependency the condition already implies, so the
//    layout does not lose the arrow it drew before.
// 6. The case label survives to the caller, so a renderer can print it.

import { expect, test } from 'vitest';
import { branchEdges } from '../../src/core/branch-edges.ts';

test('a gated node gets a branch edge from its router, tagged with the case', () => {
  const edges = branchEdges([
    { id: 'gate', routes: ['pass', 'fail'] },
    { id: 'ship', when: { node: 'gate', case: 'pass' } },
  ]);
  expect(edges).toEqual([{ id: 'branch:gate->ship:pass', source: 'gate', target: 'ship', case: 'pass' }]);
});

test('a branch edge is distinguishable from a plain dependency edge', () => {
  const edges = branchEdges([
    { id: 'gate' },
    { id: 'plain', dependsOn: ['gate'] },
    { id: 'gated', dependsOn: ['gate'], when: { node: 'gate', case: 'fail' } },
  ]);
  // Only the gated node produces one; `plain` depends on the same node but branches on nothing.
  expect(edges.map(edge => edge.target)).toEqual(['gated']);
  expect(edges[0]!.id.startsWith('branch:')).toBe(true);
});

test('a container gate counts, or a gated branch group would be invisible', () => {
  const edges = branchEdges(
    [{ id: 'gate', routes: ['text', 'json'] }],
    [{ id: 'inner', when: { node: 'gate', case: 'json' }, outputs: [] }],
    // The container's own leaves are what a renderer draws; the edge names the container.
    { 'inner': ['json-node'] },
  );
  expect(edges).toEqual([{ id: 'branch:gate->json-node:json', source: 'gate', target: 'json-node', case: 'json' }]);
});

test('a node with no when gets no branch edge: nothing is invented', () => {
  expect(branchEdges([{ id: 'gate' }, { id: 'plain', dependsOn: ['gate'] }])).toEqual([]);
});

test('a condition naming a router that declares no routes is still drawn, so the defect shows', () => {
  // The graph validator refuses this, but a proposal can be looked at before it is confirmed; the
  // picture should not hide the branch it does declare.
  const edges = branchEdges([{ id: 'gate' }, { id: 'x', when: { node: 'gate', case: 'pass' } }]);
  expect(edges).toEqual([{ id: 'branch:gate->x:pass', source: 'gate', target: 'x', case: 'pass' }]);
});
