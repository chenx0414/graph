import type { ContainerSpec, NodeSpec } from './types.ts';

/**
 * The branch edges a graph picture needs.
 *
 * `layoutGraph` draws dependencies and rework back-edges, but a `when` condition — the thing that
 * actually decides which branch runs — was not part of the layout input at all, so "which case leads
 * where" was invisible. The condition is already on the node, so this is a projection: no new field,
 * and the same rule the runtime uses (`GraphState.readiness` reads exactly this `when`).
 *
 * A branch edge is tagged, never merged into a dependency edge: a plain arrow into the same node
 * means "waits for it", while a branch edge means "runs when this case was chosen". Drawing them the
 * same way would be the picture lying about the graph.
 */

/** What a branch edge needs from a node. Extra fields are fine: a caller passes real NodeSpecs. */
export interface BranchNode extends Pick<NodeSpec, 'id' | 'when'> {
  routes?: string[];
  dependsOn?: string[];
  container?: string;
}

/** What a branch edge needs from a container. */
export interface BranchContainer extends Pick<ContainerSpec, 'id' | 'when'> {
  parent?: string;
  outputs?: string[];
}

export interface BranchEdge {
  id: string;
  source: string;
  target: string;
  /** The case this branch waits for, kept so a renderer can label it. */
  case: string;
}

export function branchEdges(
  nodes: readonly BranchNode[],
  containers: readonly BranchContainer[] = [],
  /** A gated container's leaves: a branch that enters a group is drawn to its members. */
  containerLeaves: Readonly<Record<string, readonly string[]>> = {},
): BranchEdge[] {
  const edges: BranchEdge[] = [];
  for (const node of nodes) {
    // A node inside a gated container is already covered by the container's own edge below.
    if (node.when) edges.push(branchEdge(node.when.node, node.id, node.when.case));
  }
  for (const container of containers) {
    if (!container.when) continue;
    // A container gate enters the group, and a group is drawn by its members: without this a gated
    // branch group would be invisible, which is the same blind spot in a different place.
    const leaves = containerLeaves[container.id] ?? [];
    if (leaves.length === 0) continue;
    for (const leaf of leaves) edges.push(branchEdge(container.when.node, leaf, container.when.case));
  }
  return edges;
}

function branchEdge(router: string, target: string, branchCase: string): BranchEdge {
  return { id: `branch:${router}->${target}:${branchCase}`, source: router, target, case: branchCase };
}

/** Whether an edge id came from `branchEdges`, so callers agree on the marker. */
export function isBranchEdge(id: string) {
  return id.startsWith('branch:');
}
