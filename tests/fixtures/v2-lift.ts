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

/**
 * Cross-container edges the last lift refused to draw.
 *
 * Drained by `takeCrossedContainerEdges()` after a lift. The old kernel isolated
 * containers, so these connections mean nothing in a flat graph; they are recorded rather
 * than dropped silently so the caller can say what was left out.
 */
const crossedContainerEdges: string[] = [];
export function takeCrossedContainerEdges(): string[] {
  const taken = [...crossedContainerEdges];
  crossedContainerEdges.length = 0;
  return taken;
}

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
  // An edge that crosses a container boundary is dropped and REPORTED rather than drawn.
  // The old kernel isolated containers, so a cross-group `dependsOn` either did not exist
  // or meant something else entirely; drawing it as a flat edge invented a connection the
  // graph never had, and it would have looked like a working graph.
  const groupOf = (id: string): string | undefined => nodes.find(node => node.id === id)?.container;
  const crossing: string[] = [];
  const liftedEdges = Object.fromEntries(nodes.flatMap(node =>
    (node.dependsOn ?? []).map(parent => {
      const from = groupOf(parent);
      const to = groupOf(node.id);
      const crosses = from !== undefined && to !== undefined && from !== to;
      if (crosses) { crossing.push(`${parent}->${node.id}`); return undefined; }
      return [`${parent}->${node.id}`, { from: `${parent}.out`, to: `${node.id}.in`, enabled: true }];
    }).filter((entry): entry is [string, { from: string; to: string; enabled: boolean }] => entry !== undefined),
  ));
  if (crossing.length > 0) crossedContainerEdges.push(...crossing);

  // A node that routes is a v2 router module (§13.4), not a node with a `routes` list -
  // the interface has no field for that, so the routes were simply lost. `when` becomes
  // the router's trigger, and each route becomes a rule. The old shape named routes as
  // bare strings; a rule needs a condition, so a route that named none emits on every run,
  // which is the old default rather than a guess.
  const liftedModules: Record<string, GraphDefinition['modules'][string]> = {};
  for (const node of nodes) {
    const routes = (node as unknown as { routes?: string[] }).routes;
    if (!routes?.length) continue;
    liftedModules[node.id] = {
      type: 'router',
      trigger: ((node as unknown as { when?: string }).when ?? 'each') as 'each' | 'once',
      inputs: { out: { protocol: LIFTED_PROTOCOL } },
      outputs: Object.fromEntries(routes.map((_target, index) => ['r' + index, { protocol: LIFTED_PROTOCOL }])),
      rules: routes.map((_target, index) => ({ when: 'true', emit: { ['r' + index]: { from: node.id } } })),
    };
  }

  return {
    schemaVersion: 2,
    name: 'lifted',
    protocols: { [LIFTED_PROTOCOL]: payload },
    nodes: liftedNodes,
    modules: liftedModules,
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
/**
 * The legacy fields a v2 definition has nowhere to put.
 *
 * `input` was dropped silently for most of this migration, and the only symptom was an
 * adapter that quietly did nothing. Every one of these can bite the same way, so the lift
 * names what it left behind instead of letting it disappear.
 */
export const LEGACY_ONLY_FIELDS = [
  'input', 'context', 'container', 'routes', 'when', 'optional', 'verifier', 'replaces', 'deliverable', 'role',
] as const;

/** Which legacy fields the given nodes carry that the lifted definition does not hold. */
export function droppedLegacyFields(nodes: NodeSpec[], definition: GraphDefinition): string[] {
  const dropped = new Set<string>();
  for (const node of nodes) {
    const spec = node as unknown as Record<string, unknown>;
    const lifted = definition.nodes[node.id] as unknown as Record<string, unknown> | undefined;
    for (const field of LEGACY_ONLY_FIELDS) {
      if (spec[field] === undefined) continue;
      // `role` is not carried, but it does not change what the node does under v2.
      if (field === 'role') continue;
      if (lifted && lifted[field] !== undefined) continue;
      dropped.add(field);
    }
  }
  return [...dropped];
}
