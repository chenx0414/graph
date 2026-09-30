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
