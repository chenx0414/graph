import type { CapabilityOperation } from './capability-bundle.ts';
import { agentTools } from './agent-tools.ts';
import { openWorkspaceCommandRunner } from './workspace-command.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { join } from 'node:path';
import { RuntimeError } from '../core/types.ts';
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
  environment?: { revision: number; workspace: string; base: string; access: ResolvedAccessPolicy };
  role: 'worker' | 'reviewer';
  operation?: CapabilityOperation;
  close(): Promise<void>;
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
  retainCapabilities?: boolean;
  access?: ResolvedAccessPolicy;
  bindings?: Pick<Parameters<typeof agentTools>[0], 'peers' | 'artifacts' | 'commitWorkspace' | 'fetch'>;
  kernel: KernelStore;
  catalog: Catalog;
  graphId: string;
  nodeId: string;
  /** The revision the node runs at; the recipe is read from it, not from mutable state. */
  revisionVersion: number;
  workspace: string;
  /** The bound project remains a skill source when the node works in a subdirectory or worktree. */
  projectRoot?: string;
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

  const known = catalog.hasDefinition(recipe);
  if (!known) throw new Error(`node ${nodeId} names recipe ${recipe}, which the catalog does not hold`);

  const action = catalog.definition(recipe).review === true ? 'review' : 'work';
  const assembly = await openAgentContextAssembly({
    catalog,
    definitionVersion: recipe,
    // Review is a recipe responsibility, independent of node names or task prose.
    action, runtime: 'node',
    workspace: options.workspace,
    ...(options.projectRoot ? { skillProjectRoot: options.projectRoot } : {}),
    ...(options.library ? { library: options.library } : {}),
  });

  const admitted = kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string } | undefined;
  const instanceId = admitted?.instance_id ?? instanceIdFor(graphId, nodeId);
  const scratchDir = join(options.instancesDir, instanceId, 'capability-scratch');
  const gate = options.gate ?? { dispatch: <T>(_id: string, _reservation: number, send: () => T): T => send(), settle: () => {} };
  const commands = await openWorkspaceCommandRunner({ workspace: options.workspace,
    scratchDir: join(scratchDir, 'commands'), gate, ...(options.access ? { access: options.access } : {}) });
  const operation = await assembly.bundle.openOperation({
    workspace: options.workspace,
    scratchDir,
    action,
    nativeTools: ['bash'], disabledTools: assembly.disabledTools,
    // A node with no gate still counts tool calls; an absent gate send is a passthrough.
    gate: options.gate ?? { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
    ...(options.access ? { access: options.access } : {}),
    hostTools: ({ readRoots }) => agentTools({ workspace: options.workspace,
      role: action === 'review' ? 'reviewer' : 'worker', readRoots: [...readRoots], catalog, ...options.bindings,
      readGraph: input => {
        // The capability operation is cached across turns. Resolve the active
        // execution's frozen revision, rather than the session's first revision.
        const execution = kernel.db.prepare("SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { revision_version: number } | undefined;
        if (!execution) throw new RuntimeError('invalid_execution', 'Graph definition reads require an active execution');
        const definition = kernel.revision(graphId, execution.revision_version)!.definition;
        if (!['nodes', 'modules', 'edges', 'protocols', 'acceptance', 'inputs', 'outputs'].includes(input.section)) throw new RuntimeError('invalid_query', 'Unknown graph definition section');
        const after = input.after ?? 0, limit = input.limit ?? 20;
        if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new RuntimeError('invalid_query', 'after must be nonnegative; limit must be 1–50');
        const entries = input.section === 'acceptance'
          ? (definition.acceptance ?? []).map(value => [value.id, value] as const)
          : Object.entries(definition[input.section as 'nodes' | 'modules' | 'edges' | 'protocols' | 'inputs' | 'outputs'] ?? {});
        const selected = input.id === undefined ? entries.slice(after, after + limit) : entries.filter(([id]) => id === input.id);
        if (input.id !== undefined && !selected.length) throw new RuntimeError('not_found', `No ${input.section} object named ${input.id}`);
        return { graphId, revision: execution.revision_version, section: input.section, total: entries.length,
          items: selected.map(([id, value]) => ({ id, value })),
          nextAfter: input.id === undefined && after + selected.length < entries.length ? after + selected.length : null };
      },
      ...(options.access ? { access: options.access } : {}),
      run: (command, args, signal) => commands.run(command, args, signal),
    }),
  });

  const composed = assembly.forOperation(operation).composed;
  const request: NodeSessionRequest = {
    role: action === 'review' ? 'reviewer' : 'worker',
    ...(options.retainCapabilities ? { operation } : {}),
    close: async () => { await operation.close(); await commands.close(); },
    binding: { instanceId, nodeId, definitionVersion: recipe },
    systemPrompt: composed.text,
    allowedToolNames: [...operation.allowedToolNames],
    stateDir: join(options.instancesDir, instanceId),
    bundleDigest: operation.bundleDigest,
    toolPolicyDigest: operation.toolPolicyDigest,
    runtimePolicyDigest: operation.runtimePolicyDigest,
  };
  if (!options.retainCapabilities) await request.close();
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
