import type { TaskStore } from './store.ts';
import type { NodeSpec } from './types.ts';
import { loadGraph } from './graph.ts';
import { ROUTE_SOURCE_KEY, type RouteSource } from './router-action.ts';

/**
 * The old kernel's routing and back-edge knowledge, in one place (Issue #1 §13.8, HB-277).
 *
 * `operation-lifecycle.ts` is almost entirely generic: admitting a node, dispatching a
 * turn, reporting a result, recovering after a crash, metering usage. Only a handful of
 * lines in it speak the old kernel's language — which case a router picked, and which
 * nodes a loop sends the work back to — and those lines were scattered, with the same
 * `loadGraph(...).plan.loops` lookup repeated three times.
 *
 * Gathering them here makes the boundary mechanical: when the old kernel is retired this
 * module, `router-action.ts` and `graph.ts` go with it, and the lifecycle keeps one import
 * instead of four scattered touch points. Nothing here changes behaviour — the routing
 * decisions stay exactly where the product has always made them.
 */

/**
 * How this router was told to pick its case, read from its own declared `input.route`.
 * A node that declares `routes` but no source is refused at settle time rather than silently
 * routing nothing — an unroutable router is a graph defect, not a quiet no-op.
 */
export function routeSourceOf(spec: NodeSpec): RouteSource | null {
  const declaredInput = spec.input;
  if (!declaredInput || typeof declaredInput !== 'object' || Array.isArray(declaredInput)) return null;
  const route = (declaredInput as Record<string, unknown>)[ROUTE_SOURCE_KEY];
  if (!route || typeof route !== 'object' || Array.isArray(route)) return null;
  const record = route as Record<string, unknown>;
  if (typeof record['declared'] === 'string') return { declared: record['declared'] };
  // `declared: null` is an Agent router saying the case comes from the Agent itself: the reviewer
  // submits `route` with its own result, and the harness only checks it against the declared cases.
  // A program cannot speak for itself this way, so it stays refused (a program must map status or a field).
  if (record['declared'] === null) return spec.kind === 'agent' ? { declared: null } : null;
  const byField = record['byField'];
  if (byField && typeof byField === 'object' && !Array.isArray(byField)) {
    const fieldRecord = byField as Record<string, unknown>;
    if (typeof fieldRecord['path'] === 'string' && fieldRecord['values'] && typeof fieldRecord['values'] === 'object' && !Array.isArray(fieldRecord['values'])) {
      return { byField: { path: fieldRecord['path'], values: fieldRecord['values'] as Record<string, string> } };
    }
    return null;
  }
  const byStatus = record['byStatus'];
  if (byStatus && typeof byStatus === 'object' && !Array.isArray(byStatus)) {
    return { byStatus: byStatus as Record<string, string> };
  }
  return null;
}

/**
 * The nodes a loop sends work back to, from one node.
 *
 * This is the old graph's `loops` list read once, in one place. Callers that only want the
 * targets pass no `case`; the routing decision passes the case it picked.
 */
export function backEdges(store: TaskStore, taskId: string, nodeId: string, routeCase?: string): string[] {
  const loops = loadGraph(store, taskId).plan.loops.filter(loop => loop.from === nodeId);
  const matched = routeCase === undefined ? loops : loops.filter(loop => loop.case === routeCase);
  return [...new Set(matched.map(loop => loop.to))];
}