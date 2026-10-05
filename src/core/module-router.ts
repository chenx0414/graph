import type { KernelStore } from './kernel-store.ts';
import type { ModuleRuntime, ModuleEvaluation } from './module-runtime.ts';
import type { Json } from './types.ts';

/**
 * Routing a module's judgment into the graph (Issue #1 §2, §6, §14).
 *
 * A node's submit already lands on its targets: a delivery to a node is queued (§7) and a
 * delivery to a module updates that module's input (§2). This is the other half of the
 * same sentence, and without it a graph stops at its first module:
 *
 *   - when a module JUDGES and emits, each emitted output travels to every enabled edge
 *     that leaves that port;
 *   - a target node gets the value queued in acceptance order;
 *   - a target MODULE has its input set and then judges in turn, so a chain of modules
 *     works the way the definition reads;
 *   - a disabled edge carries nothing, and a judgment that emits nothing produces no
 *     deliveries at all.
 *
 * The cascade is depth-limited. §6 allows a rework loop as an ordinary connection, so a
 * module may legitimately reach a module that reaches the first one again; the limit keeps
 * a single routing pass finite, and leaves the loop to be driven by the next real
 * delivery rather than by unbounded recursion inside one judgment.
 */

/** How deep one routing pass may cascade through module→module edges. */
export const MAX_ROUTING_DEPTH = 8;

export interface Landing {
  edgeId: string;
  fromEndpoint: string;
  toEndpoint: string;
  /** Whether the value landed on a node's queue or on another module's input. */
  kind: 'node' | 'module';
  value: Json;
}

function endpointOwner(reference: string): string {
  const dot = reference.indexOf('.');
  return dot < 0 ? reference : reference.slice(0, dot);
}

/**
 * Take one module evaluation's outputs and land them on their targets. Returns what
 * landed, so a caller can log or assert the routing rather than infer it.
 */
export function routeModuleOutputs(
  kernel: KernelStore,
  modules: ModuleRuntime,
  graphId: string,
  moduleId: string,
  evaluation: ModuleEvaluation,
  depth = 0,
  queueOnly = false,
): Landing[] {
  if (!evaluation.emitted || Object.keys(evaluation.outputs).length === 0) return [];

  const landings: Landing[] = [];
  // No downstream work begins until every output and enabled target has passed validation.
  const deliveries = kernel.broadcastModule(graphId, moduleId, evaluation.outputs, evaluation.transitionId);
  const definition = kernel.latestRevision(graphId)!.definition;
  for (const delivery of deliveries) {
    const owner = endpointOwner(delivery.toEndpoint);
    const isModule = !!definition.modules[owner];
    landings.push({ edgeId: delivery.edgeId!, fromEndpoint: delivery.fromEndpoint,
      toEndpoint: delivery.toEndpoint, kind: isModule ? 'module' : 'node', value: delivery.value });
    if (isModule && !queueOnly && depth + 1 < MAX_ROUTING_DEPTH) {
      const port = delivery.toEndpoint.slice(delivery.toEndpoint.indexOf('.') + 1);
      const next = modules.deliver(owner, port, delivery.value);
      kernel.db.prepare('UPDATE kernel_module_inbox SET processed=1 WHERE delivery_id=?').run(delivery.id);
      landings.push(...routeModuleOutputs(kernel, modules, graphId, owner, next, depth + 1));
    }
  }
  return landings;
}
