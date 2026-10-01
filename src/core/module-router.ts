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

function endpointPort(reference: string): string {
  const dot = reference.indexOf('.');
  return dot < 0 ? '' : reference.slice(dot + 1);
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
): Landing[] {
  if (!evaluation.emitted || Object.keys(evaluation.outputs).length === 0) return [];

  const revision = kernel.latestRevision(graphId);
  if (!revision) return [];
  const definition = revision.definition;
  const landings: Landing[] = [];

  for (const [port, value] of Object.entries(evaluation.outputs)) {
    const fromPort = `${moduleId}.${port}`;
    // Only edges that leave THIS module's port carry this output.
    for (const [edgeId, edge] of Object.entries(definition.edges)) {
      if (edge.from !== fromPort || edge.enabled === false) continue;

      const targetOwner = endpointOwner(edge.to);
      const targetPort = endpointPort(edge.to);
      const protocol = resolveProtocol(definition, edge.to);
      const targetModule = definition.modules[targetOwner];

      const delivery = kernel.recordModuleDelivery(graphId, {
        moduleId, edgeId, fromEndpoint: moduleId, toEndpoint: edge.to,
        value, protocol, revisionVersion: revision.version,
      });

      if (targetModule) {
        // A module target keeps the latest value and judges in turn (the cascade).
        kernel.setModuleInput(graphId, targetOwner, targetPort, value, `delivery:${delivery.id}`);
        landings.push({ edgeId, fromEndpoint: moduleId, toEndpoint: edge.to, kind: 'module', value });
        if (depth + 1 < MAX_ROUTING_DEPTH) {
          const next = modules.evaluate(targetOwner);
          landings.push(...routeModuleOutputs(kernel, modules, graphId, targetOwner, next, depth + 1));
        }
        continue;
      }

      // A node target is queued in acceptance order (§7).
      const node = definition.nodes[targetOwner];
      if (!node) continue;
      kernel.enqueueDelivery(graphId, targetOwner, { deliveryId: delivery.id, input: targetPort, value });
      landings.push({ edgeId, fromEndpoint: moduleId, toEndpoint: edge.to, kind: 'node', value });
    }
  }
  return landings;
}

/** The protocol an endpoint accepts, read from the target's declaration (§4). */
function resolveProtocol(definition: { nodes: Record<string, { inputs: Record<string, { protocol: string }> }>; modules: Record<string, { inputs: Record<string, { protocol: string }> }> }, endpoint: string): string {
  const owner = endpointOwner(endpoint);
  const port = endpointPort(endpoint);
  const node = definition.nodes[owner];
  if (node?.inputs[port]) return node.inputs[port]!.protocol;
  const module = definition.modules[owner];
  if (module?.inputs[port]) return module.inputs[port]!.protocol;
  return '';
}
