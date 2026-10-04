import { join } from 'node:path';
import type { KernelStore } from '../core/kernel-store.ts';
import type { Catalog } from '../catalog/catalog.ts';
import { openAgentContextAssembly } from './agent-context-assembly.ts';
import type { AgentContextLibrary } from './agent-context.ts';
import { type SendGate } from './controlled-openai.ts';

/**
 * The v2-native session assembly for one graph node (Issue #1 §13.8, §5, §10).
 *
 * The old path assembles a node's Pi session from an "operation": `operation.id`,
 * `operation.grants`, `spec.action`, activations. The v2 kernel has none of those — §3/§5
 * replace them with delivery and execution — so a v2 node's session is assembled from what
 * a v2 node actually has: its `recipe`, which names a catalog definition version (§5), on
 * the project workspace.
 *
 * This is assembly, not transport: it produces the system prompt, the tool surface and the
 * three digests the resident worker binds to, plus the per-node state directory. The host
 * that spawns the process turns this into a real session request.
 *
 * Two nodes never share a session: the state directory is derived from the node id, so a
 * graph's nodes get distinct, stable session lineages (§7).
 */

export interface NodeSessionRequest {
  /** The binding the resident worker persists its session against. */
  binding: { instanceId: string; nodeId: string; definitionVersion: string };
  /** The composed system prompt for this node's recipe. */
  systemPrompt: string;
  /** Tool names the session may call, exactly as the bundle declared them. */
  allowedToolNames: string[];
  /** The node's own session directory: two nodes never share one. */
  stateDir: string;
  bundleDigest: string;
  toolPolicyDigest: string;
  runtimePolicyDigest: string;
}

export interface NodeSessionOptions {
  kernel: KernelStore;
  catalog: Catalog;
  graphId: string;
  nodeId: string;
  /** The revision the node runs at; the recipe is read from it, not from mutable state. */
  revisionVersion: number;
  workspace: string;
  /** Where per-node session directories live. */
  instancesDir: string;
  /** The gate the capability layer reports permission requests through. */
  gate?: SendGate;
  /** Prompt-capability library, when the runtime has one. */
  library?: AgentContextLibrary;
}

/** The node's declared recipe, read from the revision's immutable definition. */
function recipeFor(kernel: KernelStore, graphId: string, nodeId: string, revisionVersion: number): string {
  const revision = kernel.revision(graphId, revisionVersion);
  if (!revision) throw new Error(`graph ${graphId} has no revision ${revisionVersion}`);
  const node = revision.definition.nodes[nodeId];
  if (!node) throw new Error(`revision ${revisionVersion} of ${graphId} declares no node ${nodeId}`);
  if (!node.recipe) throw new Error(`node ${nodeId} of graph ${graphId} is a command node and has no recipe to assemble`);
  return node.recipe;
}

/**
 * Assemble one node's session from its recipe. A recipe that names a definition the catalog
 * does not hold fails loudly: assembling a nameless session would run the node as a
 * generic Agent with the wrong tool surface, which is worse than refusing.
 */
export async function nodeSessionRequest(options: NodeSessionOptions): Promise<NodeSessionRequest> {
  const { kernel, catalog, graphId, nodeId } = options;
  const recipe = recipeFor(kernel, graphId, nodeId, options.revisionVersion);

  const known = catalog.listDefinitions().some(item => `${item.id}@${item.version}` === recipe);
  if (!known) throw new Error(`node ${nodeId} names recipe ${recipe}, which the catalog does not hold`);

  const assembly = await openAgentContextAssembly({
    catalog,
    definitionVersion: recipe,
    // A v2 node has no action/role; the definition carries the identity, and the registry
    // resolves the worker shape from `action`. "work" is the plain worker action.
    action: 'work',
    workspace: options.workspace,
    ...(options.library ? { library: options.library } : {}),
  });

  const scratchDir = join(options.instancesDir, instanceIdFor(graphId, nodeId), 'capability-scratch');
  const operation = await assembly.bundle.openOperation({
    workspace: options.workspace,
    scratchDir,
    action: 'work',
    // A node with no gate still counts tool calls; an absent gate send is a passthrough.
    gate: options.gate ?? { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
    hostTools: () => [],
  });

  const composed = assembly.forOperation(operation).composed;
  const request: NodeSessionRequest = {
    binding: { instanceId: instanceIdFor(graphId, nodeId), nodeId, definitionVersion: recipe },
    systemPrompt: composed.text,
    allowedToolNames: [...operation.allowedToolNames],
    stateDir: join(options.instancesDir, instanceIdFor(graphId, nodeId)),
    bundleDigest: operation.bundleDigest,
    toolPolicyDigest: operation.toolPolicyDigest,
    runtimePolicyDigest: operation.runtimePolicyDigest,
  };
  await operation.close();
  return request;
}

/**
 * The node's instance id. Derived from the graph and node so the same node always resolves
 * to the same session directory: a node keeps its lineage across runs, and two nodes never
 * collide.
 */
function instanceIdFor(graphId: string, nodeId: string): string {
  return `k-${graphId}-${nodeId}`;
}
