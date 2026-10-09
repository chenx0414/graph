// The design examples must be graphs this product actually accepts.
//
// A "copy this" example that the validator refuses is worse than no example: it teaches a shape that
// cannot run, and nothing catches it because prose does not compile. So every JSON block in the
// examples document is parsed and handed to the product's own validator - the same function the
// supervisor calls - and the test fails if the document drifts away from the code.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { validateProposal } from '../../src/core/proposal.ts';
import { resolveRouteCase } from '../../src/core/router-action.ts';
import type { Proposal } from '../../src/core/types.ts';

const document = readFileSync(join(import.meta.dirname, '..', '..', 'docs', 'design-graph-examples.md'), 'utf8');

/**
 * Every fenced json block that is a whole graph, in document order. The document also carries
 * fragments (a lone `deliverable`, a report shape, a snippet); those are not graphs and are skipped
 * by the same rule a reader uses - a graph has `nodes`.
 */
function examples(): { index: number; proposal: Proposal }[] {
  const blocks: { index: number; proposal: Proposal }[] = [];
  for (const match of document.matchAll(/```json\n([\s\S]*?)```/g)) {
    const body = match[1]!.trim();
    if (!body.includes('"nodes"')) continue;
    const parsed = JSON.parse(body.replaceAll('<模型 id>', 'example:model')) as Proposal;
    if (!Array.isArray(parsed.nodes)) continue;
    blocks.push({ index: blocks.length + 1, proposal: parsed });
  }
  return blocks;
}

test('the examples document holds graphs the validator accepts', () => {
  const blocks = examples();
  expect(blocks.length, 'the document should carry at least one copy-me graph').toBeGreaterThan(0);
  for (const block of blocks) {
    const outcome = (() => {
      try {
        validateProposal(block.proposal);
        return 'accepted';
      } catch (error) {
        return `refused: ${(error as Error).message}`;
      }
    })();
    expect(outcome, `example #${block.index} (${block.proposal.summary ?? 'no summary'})`).toBe('accepted');
  }
});

test('each example names the checks its acceptance items point at', () => {
  // An acceptance item whose checkNode is not a node of the graph is the classic copy-me mistake.
  for (const { index, proposal } of examples()) {
    const ids = new Set(proposal.nodes.map(node => node.id));
    for (const item of proposal.acceptance) {
      expect(ids.has(item.checkNode), `example #${index}: acceptance ${item.id} points at ${item.checkNode}`).toBe(true);
    }
    for (const loop of proposal.loops ?? []) {
      expect(ids.has(loop.from), `example #${index}: loop from ${loop.from}`).toBe(true);
      if (loop.to) expect(ids.has(loop.to), `example #${index}: loop to ${loop.to}`).toBe(true);
    }
  }
});

/**
 * The mechanical-judgement graph - the one example whose arbitration is a `program` node with a
 * `pass` diamond (`graph.verify` + `multiview`). Selecting by that node is what makes the test below
 * fail loudly when the example is missing, instead of silently asserting nothing.
 */
function mechanicalJudgementGraph(): { index: number; proposal: Proposal } {
  const found = examples().find(example => example.proposal.nodes.some(node => node.id === 'pass'));
  expect(found, 'the document should carry the graph.verify example, the one with a `pass` node').toBeDefined();
  if (!found) throw new Error('unreachable: the example was asserted to exist above');
  return found;
}

test('the graph.verify example pins the arrows that differ from the v40 shape', () => {
  const { proposal } = mechanicalJudgementGraph();
  const byId = new Map(proposal.nodes.map(node => [node.id, node]));
  const node = (id: string) => {
    const found = byId.get(id);
    expect(found, `the example should carry node ${id}`).toBeDefined();
    if (!found) throw new Error(`unreachable: node ${id} was asserted to exist above`);
    return found;
  };
  const loops = proposal.loops ?? [];

  // 1. The rework edge returns to the worker, and only to the worker. A second `pass` loop, or one
  //    pointing at another node, is the batch-rework shape leaking in from v40.
  expect(loops.filter(loop => loop.from === 'pass')).toEqual([{ from: 'pass', to: 'worker', case: 'no' }]);

  // 2. The plan lane is parallel: the worker starts from the plan alone and never waits on the plan
  //    review (v40 upgrades it to a `when` gate). The replan edge still exists, on its own lane.
  const worker = node('worker');
  expect(worker.when).toBeUndefined();
  expect(worker.dependsOn ?? []).not.toContain('plan-reviewer');
  expect(loops).toContainEqual({ from: 'plan-reviewer', to: 'planner', case: 'replan' });

  // 3. The verdict travels through `byField`, read from the judge's own output. `byStatus` cannot
  //    produce the rework branch at all: a node that has a verdict has completed, so it always maps
  //    to the same case and the loop below becomes dead code.
  const pass = node('pass');
  expect(pass.routes).toEqual(['yes', 'no']);
  expect((pass.input as Record<string, unknown> | undefined)?.['route'])
    .toEqual({ byField: { path: 'outcome', values: { pass: 'yes', rework: 'no' } } });
  expect(resolveRouteCase({
    nodeId: 'pass', routes: ['yes', 'no'], status: 'completed', output: { outcome: 'rework' },
    source: { byStatus: { completed: 'yes' } },
  })).toEqual({ case: 'yes' });
  expect(resolveRouteCase({
    nodeId: 'pass', routes: ['yes', 'no'], status: 'completed', output: { outcome: 'rework' },
    source: { byField: { path: 'outcome', values: { pass: 'yes', rework: 'no' } } },
  })).toEqual({ case: 'no' });

  // 4. Only a passing verdict reaches the summary, and the last gate is the human one.
  expect(node('haiku').when).toEqual({ node: 'pass', case: 'yes' });
  expect(node('deliver').action).toBe('graph.human_check');
});
