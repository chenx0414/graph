import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { KernelStore } from '../core/kernel-store.ts';
import type { Catalog } from '../catalog/catalog.ts';
import type { ModelEntry } from '../catalog/models.ts';
import { GraphLane } from '../core/graph-lane.ts';
import type { ArtifactWorkspace } from '../core/artifact-workspace.ts';
import { ResidentHost } from './resident-host.ts';
import { nodeSessionRequest, type NodeSessionRequest } from './kernel-node-host.ts';
import { toPiModel } from './pi-adapter.ts';
import type { SendGate } from './controlled-openai.ts';
import type { GitIntegration } from '../git/integration.ts';

/**
 * The production wiring of the v2 graph lane (Issue #1 §13.8).
 *
 * Everything the lane needs exists separately: the lane drives a graph (GraphLane), the
 * session for a node comes from its recipe (nodeSessionRequest), and the worker reaches the
 * provider with the host's credential (PiWorkerConfig.transport). This assembles them into
 * the one call `Execution` needs — `graphs()` — so a confirmed v2 graph runs in the running
 * product instead of only in tests.
 *
 * Credentials stay with the host (§3): the lane resolves a model and its credential for each
 * node here and hands the worker a concrete apiKey, so the worker never invents one.
 */

const workerEntry = fileURLToPath(new URL('./resident-worker-entry.ts', import.meta.url));

export interface KernelGraphLaneOptions {
  kernel: KernelStore;
  catalog: Catalog;
  /** The models the runtime is configured with. */
  directory: () => ModelEntry[];
  /** Resolve the credential for a model entry; undefined means the node cannot run. */
  credentialFor: (entry: ModelEntry) => { apiKey: string } | undefined;
  /** Where per-node session directories live. */
  instancesDir: string;
  /** The state root; worker configs are written beneath it. */
  stateDir: string;
  /** The project workspace for a graph, resolved from its task row. */
  workspaceFor: (graphId: string) => string | undefined;
  /**
   * The real Git integration, used to give each node its OWN work copy. The old kernel gave
   * every agent a worktree seeded from the integration tip; a v2 node keeps the same
   * isolation, so two nodes never edit one tree (HB-276).
   */
  git?: GitIntegration;
  /** The artifact store a node's declared deliverable is published to. */
  artifacts?: ArtifactWorkspace;
  /** The gate for a node; absent means an unmetered passthrough (tests). */
  gateFor?: (graphId: string, nodeId: string) => SendGate | undefined;
  /**
   * Runs a node's tool call in the host (§5, HB-262): the kernel's `submit` reaches here,
   * where the execution identity lives, so the model can never forge it.
   */
  onToolCall?: (graphId: string, nodeId: string, name: string, args: unknown) => { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }>;
}

/** The first configured model of the grade a definition recommends. */
export function modelFor(options: KernelGraphLaneOptions, recipe: string): ModelEntry | undefined {
  const entry = options.catalog.definition(recipe);
  const directory = options.directory();
  if (!entry) return undefined;
  return directory.find(model => model.grade === entry.recommendedGrade) ?? directory[0];
}

/**
 * Build the production v2 lane. A node's session is assembled once and reused for the life
 * of the lane, so the same node keeps one resident process across the graph's turns (§7).
 */
export function kernelGraphLane(options: KernelGraphLaneOptions): GraphLane {
  const hosts = new Map<string, ResidentHost>();
  const sessions = new Map<string, NodeSessionRequest>();

  /** The workspace a node works in: its own work copy when Git can provide one. */
  const nodeWorkspace = (graphId: string, nodeId: string): string | undefined => {
    const admitted = options.kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string } | undefined;
    // A work copy is keyed by the node's admitted instance, which is stable for the life of
    // the node, so a rework keeps the commits the node already made.
    if (options.git && admitted?.instance_id) {
      const copy = options.git.workspace(graphId, admitted.instance_id, nodeId, 'agent', 'work');
      if (copy) return copy;
    }
    return options.workspaceFor(graphId);
  };

  const sessionFor = async (graphId: string, nodeId: string): Promise<NodeSessionRequest> => {
    const key = `${graphId}/${nodeId}`;
    const cached = sessions.get(key);
    if (cached) return cached;
    const revision = options.kernel.latestRevision(graphId);
    if (!revision) throw new Error(`graph ${graphId} has no revision to run`);
    const workspace = nodeWorkspace(graphId, nodeId);
    if (!workspace) throw new Error(`graph ${graphId} node ${nodeId} has no workspace`);
    const session = await nodeSessionRequest({
      kernel: options.kernel,
      catalog: options.catalog,
      graphId,
      nodeId,
      revisionVersion: revision.version,
      workspace,
      instancesDir: options.instancesDir,
      ...(options.gateFor?.(graphId, nodeId) ? { gate: options.gateFor(graphId, nodeId)! } : {}),
    });
    sessions.set(key, session);
    return session;
  };

  return new GraphLane({
    kernel: options.kernel,
    // A node's declared deliverable is settled from its own work copy into the shared
    // artifact store, so work the node produced is published without a tool call (§13.8).
    workspace: nodeWorkspace,
    ...(options.artifacts ? { artifacts: () => options.artifacts } : {}),
    // The worker config: the node's own session plus the credential the host resolved.
    config: async (graphId, nodeId) => {
      const session = await sessionFor(graphId, nodeId);
      const recipe = session.binding.definitionVersion;
      const model = modelFor(options, recipe);
      if (!model) throw new Error(`no configured model for recipe ${recipe}`);
      const credential = options.credentialFor(model);
      if (!credential) throw new Error(`no credential bound for model ${model.id}`);
      const workspace = nodeWorkspace(graphId, nodeId) ?? options.stateDir;
      return {
        binding: session.binding,
        workspace,
        stateDir: session.stateDir,
        model: toPiModel(model),
        thinkingLevel: 'off',
        // §5: a node's only kernel tool is `submit`. The host executes the call against the
        // real execution (HB-262), so the model can never forge an executionId.
        tools: [{
          name: 'submit', label: 'Submit',
          description: 'Submit this node required outputs through the graph kernel.',
          parameters: { type: 'object' } as never,
        }],
        nativeTools: [],
        skillPaths: [],
        piExtensionPaths: [],
        piExtensionTools: [],
        systemPrompt: session.systemPrompt,
        allowedToolNames: ['submit', ...session.allowedToolNames.filter(name => name !== 'submit')],
        bundleDigest: session.bundleDigest,
        toolPolicyDigest: session.toolPolicyDigest,
        runtimePolicyDigest: session.runtimePolicyDigest,
        // The credential travels with the config so the worker reaches the provider (§3).
        transport: { apiKey: credential.apiKey, api: model.api },
      };
    },
    // One resident process per node, reused across turns.
    host: async (graphId: string, nodeId: string, config: unknown) => {
      const cached = hosts.get(nodeId);
      if (cached) return cached;
      await mkdir(join(options.stateDir, 'kernel-worker'), { recursive: true });
      const workspace = nodeWorkspace(graphId, nodeId) ?? options.stateDir;
      const host = new ResidentHost({
        workerEntry,
        cwd: workspace,
        configPath: join(options.stateDir, 'kernel-worker', `${nodeId}.json`),
        config: config as never,
        // The node's `submit` runs in the host, over the real execution (HB-262): the lane
        // wires that through `onToolCall` when it builds the runner.
        onToolCall: (name, args) => options.onToolCall?.(graphId, nodeId, name, args) ?? { ok: false, text: `the host does not offer a tool named ${name}` },
      });
      hosts.set(nodeId, host);
      return host;
    },
  });
}
