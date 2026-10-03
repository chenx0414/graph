import type { GraphDefinition } from '../../src/core/interface-spec.ts';
import type { NodeSpec, Proposal } from '../../src/core/types.ts';

/**
 * Issue #1 ADR 0030 / HB-279: a test-only lift from the old declarative proposal shape
 * to the v2 graph definition a draft now has to carry.
 *
 * This is a TEST FIXTURE, not the converter ADR 0030 refused to build. The product has
 * no compatibility path: a draft without a definition is refused. Tests, however, are
 * the evidence that shared infrastructure still works, and most of them only used the
 * old shape as setup while asserting something that survives (git admission, merge,
 * credentials, the conversation UI). Rewriting each of those assertions from scratch
 * would replace evidence with fresh assertions of our own making, which proves much less
 * than the tests already prove. So the setup is lifted mechanically and the assertions
 * are left exactly as they were.
 *
 * What this cannot do: express old-kernel-only behaviour. Loops, nested containers,
 * rework routes and verifier gates have no v2 spelling here, so a lifted definition is a
 * pipeline of independent nodes. Tests asserting those semantics are migrated by hand or
 * retired with the kernel, never through this fixture.
 *
 * The lift is deliberately dumb - one recipe node per old node, one protocol, edges
 * mirroring `dependsOn` - because a clever lift would hide the very thing the test is
 * supposed to be about. It is checked against the real parser in `v2-lift.test.ts`, so a
 * shape that stops being legal fails loudly there rather than quietly in 78 files.
 */

/** The recipe a lifted node gets. Overridable so a test can pin a specific recipe. */
export const LIFTED_RECIPE = 'worker@1';

/** The single protocol every lifted port speaks. */
export const LIFTED_PROTOCOL = 'lifted-payload';

/**
 * Deliberately permissive: NO required properties.
 *
 * An earlier version required `value`, and the kernel correctly refused every lifted
 * submission with `output_protocol_mismatch` - the old shape's outputs (`{ version: 1 }`,
 * `{ stable: true }`, …) have no `value` field. A mechanical lift cannot know the shape a
 * test's action returns, so it must not invent one: requiring a field the caller was never
 * told about makes migration impossible for exactly the tests it is meant to help.
 */
const payload: GraphDefinition['protocols'][string] = {
  type: 'object',
  properties: { value: { type: 'string' }, text: { type: 'string' } },
};

export interface LiftOptions {
  /** The recipe id used for every lifted node. */
  recipe?: string;
  /** Task text for lifted nodes; defaults to the old node's action. */
  task?: string;
}

export function liftDefinition(nodes: NodeSpec[], options: LiftOptions = {}): GraphDefinition {
  const recipe = options.recipe ?? LIFTED_RECIPE;

  const liftedNodes = Object.fromEntries(nodes.map(node => [
    node.id,
    {
      recipe,
      task: options.task ?? node.action,
      inputs: { in: { protocol: LIFTED_PROTOCOL } },
      outputs: { out: { protocol: LIFTED_PROTOCOL } },
      submission: { required: ['out'] },
    },
  ]));

  // `dependsOn` becomes a real edge. The old shape's edges were scheduling-only; v2 edges
  // also carry data, so a lifted graph states that intent explicitly instead of leaving
  // it implied.
  const liftedEdges = Object.fromEntries(nodes.flatMap(node =>
    (node.dependsOn ?? []).map(parent => [
      `${parent}->${node.id}`,
      { from: `${parent}.out`, to: `${node.id}.in`, enabled: true },
    ]),
  ));

  return {
    schemaVersion: 2,
    name: 'lifted',
    protocols: { [LIFTED_PROTOCOL]: payload },
    nodes: liftedNodes,
    modules: {},
    edges: liftedEdges,
    inputs: Object.fromEntries(nodes.map(node => [`${node.id}.in`, { to: `${node.id}.in`, protocol: LIFTED_PROTOCOL }])),
    outputs: Object.fromEntries(nodes.map(node => [`${node.id}.out`, { from: `${node.id}.out`, protocol: LIFTED_PROTOCOL }])),
  };
}

/**
 * Return the proposal with a definition attached, leaving every other field alone so the
 * test's own setup (acceptance ids, node ids, roles) keeps meaning what it meant.
 */
export function withLiftedDefinition(proposal: Proposal, options: LiftOptions = {}): Proposal {
  if (proposal.definition) return proposal;
  return { ...proposal, definition: liftDefinition(proposal.nodes, options) };
}