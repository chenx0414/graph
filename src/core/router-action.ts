import type { Json } from './types.ts';

/**
 * Deciding which branch a router takes.
 *
 * The graph side already existed: `GraphState.readiness` skips any node whose `when.case` does not
 * match the router's `route`, and `operation-lifecycle` refuses a route the node never declared.
 * What did not exist was anything that could produce a case. Proven live: a real `templates.router()`
 * graph saw EVERY branch skip, and the production ledger had `route` non-null on 0 of 216 nodes.
 *
 * The user's design keeps this to one action with two honest sources:
 *   - a tool node decides from its own result (`byStatus`, or a declared `byField` on its output);
 *   - an agent node declares the case itself (`declared`).
 * Whatever the source, the case must be one the node declared: a router may choose among the
 * branches it announced, never invent one.
 */

export interface RouteDecisionInput {
  nodeId: string;
  /** The cases this router declared. A case outside this list is always refused. */
  routes: readonly string[];
  /** The router's own final status, for a tool node deciding from its result. */
  status: string;
  /** The router's own output, for a declared field. */
  output: Json | null;
  source: RouteSource;
}

/** How this router is allowed to pick its case. Exactly one source, so there is no precedence puzzle. */
export type RouteSource =
  /** Tool node: map its own status onto a case. */
  | { byStatus: Readonly<Record<string, string>> }
  /** Tool node: read one field of its own output and map its value onto a case. */
  | { byField: { path: string; values: Readonly<Record<string, string>> } }
  /** Agent node: the case it declared for itself, or `null` when the case comes from the Agent's own `result.route`. */
  | { declared: string | null };

export type RouteDecision = { case: string } | { refusal: string };

function declared(routes: readonly string[], candidate: string, why: string): RouteDecision {
  if (!routes.includes(candidate)) {
    return { refusal: `路由 ${why} 得到 ${candidate}，但它没有声明这个分支（已声明：${routes.join(', ') || '无'}）。` };
  }
  return { case: candidate };
}

function field(output: Json | null, path: string): unknown {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return undefined;
  // A declared path is a plain key, kept key-shaped on purpose: a router should not need a query
  // language to say "look at outcome".
  return (output as Record<string, unknown>)[path];
}

export function resolveRouteCase(input: RouteDecisionInput): RouteDecision {
  const source = input.source;
  if ('declared' in source) {
    // An Agent router that speaks for itself must actually have spoken. Reaching here with no case
    // means the Agent declared branches but submitted no `route`, which is a refusal — never a
    // silent default, or every branch would skip and the graph would look finished when it is not.
    if (source.declared === null) {
      return { refusal: `节点 ${input.nodeId} 由自己选择分支，但提交的结果里没有 route（已声明：${input.routes.join(', ') || '无'}）。` };
    }
    return declared(input.routes, source.declared, '节点自述');
  }
  if ('byField' in source) {
    const value = field(input.output, source.byField.path);
    if (value === undefined || value === null) {
      return { refusal: `节点 ${input.nodeId} 的产物里没有 ${source.byField.path}，无法据此选分支。` };
    }
    const mapped = source.byField.values[String(value)];
    if (mapped === undefined) {
      return { refusal: `${source.byField.path}=${String(value)} 没有映射到任何分支（已声明：${input.routes.join(', ') || '无'}）。` };
    }
    return declared(input.routes, mapped, `字段 ${source.byField.path}`);
  }
  const mapped = source.byStatus[input.status];
  if (mapped === undefined) {
    return { refusal: `节点 ${input.nodeId} 的状态是 ${input.status}，没有映射到任何分支（已声明：${input.routes.join(', ') || '无'}）。` };
  }
  return declared(input.routes, mapped, '状态');
}

/** Where the routing instruction lives on the router node, so the loader and the docs agree. */
export const ROUTE_SOURCE_KEY = 'route';

/**
 * Whether this node decides its branch for itself (`declared: null` on an Agent node). Only an Agent
 * can speak for itself; a program must map a status or a field instead. The briefing uses this to tell
 * the Agent its structured result has to carry `route`, and the loader uses it to build the source.
 */
export function agentChoosesItsOwnRoute(node: { kind: string; input?: Json }): boolean {
  if (node.kind !== 'agent') return false;
  const input = node.input;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const route = (input as Record<string, unknown>)[ROUTE_SOURCE_KEY];
  if (!route || typeof route !== 'object' || Array.isArray(route)) return false;
  return (route as Record<string, unknown>)['declared'] === null;
}
