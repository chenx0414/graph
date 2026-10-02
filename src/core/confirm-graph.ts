import { randomUUID } from 'node:crypto';
import type { KernelStore } from './kernel-store.ts';
import { parseGraphDefinition, type GraphDefinition } from './interface-spec.ts';

/**
 * The v2 half of the §13.8 switchover (Issue #1 §13.8).
 *
 * Confirmation is the moment a task's graph comes into existence. The old path wrote
 * `proposals` / `graph_revisions` / `nodes` / `activations` rows and handed the result to
 * the old executor; a draft that carries a v2 `GraphDefinition` (what
 * `graph_create(definition)` takes, §5) must instead come into existence as a real v2
 * graph. This module materialises exactly that, on the same task row, at revision 1.
 *
 * It runs inside the caller's transaction, so a refusal leaves no half-built graph: the
 * whole attempt rolls back and the confirmed draft produces either a complete v2 graph or
 * nothing. It admits every node and module declared by revision 1, which is what makes
 * the graph runnable by `GraphRunner` rather than merely displayable.
 */
export interface MaterializedGraph {
  revision: { version: number };
  definition: GraphDefinition;
  nodeIds: string[];
  moduleIds: string[];
  /** The entry nodes queued at materialisation, so the graph has somewhere to start. */
  roots: string[];
}

export function materializeGraph(
  kernel: KernelStore,
  taskId: string,
  definition: GraphDefinition,
  reason: string,
): MaterializedGraph {
  // Refusing a second materialisation keeps a retried confirmation from doubling every
  // row: a graph comes into existence once.
  if (kernel.latestRevision(taskId)) {
    throw new Error(`task ${taskId} already has a v2 graph; materialising it again would duplicate its rows`);
  }

  // insertRevision validates the definition and writes revision 1 whole-or-nothing, and
  // unlike publishRevision it does NOT open its own transaction. Confirmation already
  // runs inside the command's transaction, so nesting a second BEGIN would abort the
  // whole confirmation (the same defect that was fixed for revision publishing). The
  // outer transaction is what makes a refusal leave no partial rows.
  const revision = kernel.insertRevision(taskId, parseGraphDefinition(definition), reason, 1);

  const nodeIds = Object.keys(revision.definition.nodes);
  const moduleIds = Object.keys(revision.definition.modules);
  for (const nodeId of nodeIds) {
    kernel.admitNode(taskId, revision.version, nodeId, { instanceId: randomUUID() });
  }
  for (const moduleId of moduleIds) {
    const declared = revision.definition.modules[moduleId]!;
    kernel.admitModule(taskId, revision.version, moduleId, { moduleType: declared.type, trigger: declared.trigger });
  }

  // A graph with no incoming edge has nothing to trigger it, so its entry nodes are queued
  // here. Without this a confirmed v2 graph is admitted and then sits forever with every
  // node idle: `GraphLane.runnable()` only names graphs holding a queued item, and nothing
  // else ever enqueues one. An edge arriving later routes normally - this only seeds what
  // nothing else would start.
  const targeted = new Set(
    Object.values(revision.definition.edges)
      .flatMap(edge => [edge.from.split('.')[0]!, edge.to.split('.')[0]!]),
  );
  const roots = nodeIds.filter(nodeId => !targeted.has(nodeId));
  if (roots.length === 0 && nodeIds.length > 0) {
    // A cycle has no entry point by definition; start from the first admitted node so the
    // graph is runnable and the cycle surfaces as work rather than as silence.
    roots.push(nodeIds[0]!);
  }
  for (const nodeId of roots) {
    // Not `kernel.enqueue`, which opens its own transaction: materialisation already runs
    // inside the caller's (see the note above), and nesting a second BEGIN aborts it.
    kernel.enqueueInCurrentTransaction(taskId, { nodeId, kind: 'start', payload: {} as never });
  }

  return { revision: { version: revision.version }, definition: revision.definition, nodeIds, moduleIds, roots };
}
