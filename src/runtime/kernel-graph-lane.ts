import { kernelToolGate } from './kernel-tool-gate.ts';
import { createRetrievalBroker } from './retrieval.ts';
import { compactionSettings } from './compaction.ts';
import { sendKernelNodeMessage } from '../core/kernel-node-messages.ts';
import { executeModuleOperation } from './kernel-operation-broker.ts';
import { waitForKernelExecutionSlot } from './execution-slots.ts';
import { setNativeExecutionWaiting } from '../core/time-ledger.ts';
import type { ModelScheduler } from './model-scheduler.ts';
import { RuntimeError } from '../core/types.ts';
import { randomUUID } from 'node:crypto';
import type { AgentContextLibrary } from './agent-context.ts';
import { nodeAccessPolicy, resolveAccessPolicy, standardAccessPolicy, type ResolvedAccessPolicy } from '../core/access-policy.ts';
import { join, resolve, relative } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { KernelStore } from '../core/kernel-store.ts';
import type { Catalog } from '../catalog/catalog.ts';
import { selectModel, modelIdentity, type ModelEntry } from '../catalog/models.ts';
import { appendNodeEntry, recordCapabilityLoad, recordNodeSession } from '../core/node-run.ts';
import { graphAcceptance } from '../core/graph-acceptance.ts';
import { GraphLane, type GraphLaneOptions } from '../core/graph-lane.ts';
import type { ArtifactWorkspace } from '../core/artifact-workspace.ts';
import { residentLauncher } from './resident-launcher.ts';
import { ResidentHost } from './resident-host.ts';
import { nodeSessionRequest, type NodeSessionRequest } from './kernel-node-host.ts';
import { toPiModel, toolResultText } from './pi-adapter.ts';
import { kernelProviderGate } from './kernel-provider-gate.ts';
import { controlledOpenAIStream, type SendGate } from './controlled-openai.ts';
import { encodeAssistantStream } from './assistant-stream-frames.ts';
import { normalizeContext, type Context } from '@earendil-works/pi-ai';
import { tokenUsageTotal, type TokenUsage } from './call-broker.ts';
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
 * Credentials stay with the host (§3): the resident worker requests a model call over IPC;
 * the host selects the model, admits each send and records its authoritative usage.
 */

const workerEntry = fileURLToPath(new URL('./resident-worker-entry.ts', import.meta.url));

/** What one v2 turn is expected to cost when the runtime has not said otherwise. */
export const DEFAULT_V2_RESERVE_TOKENS = 200_000;

export interface KernelGraphLaneOptions {
  kernel: KernelStore;
  access?: () => ResolvedAccessPolicy;
  network?: { retrievalDomains?: string[] };
  program?: { readPaths?: string[]; env?: Record<string, string>; nodeModulesPath?: string };
  catalog: Catalog;
  library?: AgentContextLibrary;
  /**
   * §9: the token budget a node runs under. Absent means unmetered - which is the right
   * default for a program node, but NOT for an agent that can spend real tokens, so the
   * runtime supplies one whenever limits are configured.
   */
  tokenBudget?: GraphLaneOptions['tokenBudget'];
  reserveTokens?: number;
  /** The models the runtime is configured with. */
  directory: () => ModelEntry[];
  preferences?: () => Partial<Record<ModelEntry['grade'], string[]>>;
  /** Resolve the credential for a model entry; undefined means the node cannot run. */
  scheduler?: ModelScheduler;
  credentialFor: (entry: ModelEntry) => { apiKey: string; credentialId?: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
  /** Where per-node session directories live. */
  instancesDir: string;
  /** The state root; worker configs are written beneath it. */
  stateDir: string;
  graphHome?: string;
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
  onMainMessage?: (graphId: string, nodeId: string, message: { text: string; requestId: string }) => Promise<unknown>;
  onToolCall?: (graphId: string, nodeId: string, name: string, args: unknown) => { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }>;

}

/** Select against immutable implementer history, including aliases and routing cycles. */
export function modelFor(options: KernelGraphLaneOptions, recipe: string,
  context?: { graphId: string; nodeId: string; revisionVersion: number }): ModelEntry | undefined {
  const entry = options.catalog.definition(recipe);
  const excluded = new Set<string>();
  if (entry.review && context) {
    const { graphId, nodeId, revisionVersion } = context;
    const definition = options.kernel.revision(graphId, revisionVersion)!.definition;
    const predecessors = new Map<string, Set<string>>();
    const connect = (from: string, to: string) => {
      const source = from.split('.')[0]!; const target = to.split('.')[0]!;
      const upstream = predecessors.get(target) ?? new Set<string>();
      upstream.add(source); predecessors.set(target, upstream);
    };
    // Disabling an edge cannot erase the identity of work already received over it.
    for (const edge of Object.values(definition.edges)) connect(edge.from, edge.to);
    const deliveries = options.kernel.db.prepare('SELECT from_endpoint,to_endpoint FROM kernel_deliveries WHERE task_id=?').all(graphId) as { from_endpoint: string; to_endpoint: string }[];
    for (const delivery of deliveries) connect(delivery.from_endpoint, delivery.to_endpoint);
    const visited = new Set<string>();
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      for (const call of options.kernel.providerCalls(graphId, id)) {
        const execution = options.kernel.execution(call.executionId);
        const producer = execution && options.kernel.revision(graphId, execution.revisionVersion)?.definition.nodes[id];
        if (!producer?.recipe) throw new RuntimeError('model_selection', `Implementer recipe history is unavailable for ${id}`);
        if (options.catalog.definition(producer.recipe).review) continue;
        if (!call.model) throw new RuntimeError('model_selection', `Implementer model history is unavailable for ${id}`);
        excluded.add(call.model.id); excluded.add(call.model.identity);
      }
      for (const upstream of predecessors.get(id) ?? []) visit(upstream);
    };
    visit(nodeId);
  }
  const directory = options.directory().filter(model => !excluded.has(model.id) && !excluded.has(modelIdentity(model)));
  const definition = context && options.kernel.revision(context.graphId, context.revisionVersion)?.definition;
  const requested = context && definition ? (definition.nodes[context.nodeId]?.model ?? definition.defaults?.model)?.trim() : undefined;
  return selectModel({ ...(requested ? { requested } : {}), grade: entry.recommendedGrade, directory, ...(options.preferences ? { preferences: options.preferences() } : {}) }) ?? directory[0];
}

/**
 * Build the production v2 lane. A node's session is assembled once and reused for the life
 * of the lane, so the same node keeps one resident process across the graph's turns (§7).
 */
export function kernelGraphLane(options: KernelGraphLaneOptions): GraphLane {
  let closing = false;
  const hosts = new Map<string, ResidentHost>();
  const sessions = new Map<string, NodeSessionRequest>();
  const sessionRevisions = new Map<string, string>();
  const hostConfigs = new Map<string, string>();
  const boundModels = new Map<string, ModelEntry>();

  const nodeDefinition = (graphId: string, nodeId: string, revisionVersion?: number) => {
    const active = options.kernel.db.prepare("SELECT revision_version FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1")
      .get(graphId, nodeId) as { revision_version: number } | undefined;
    const revision = revisionVersion ?? active?.revision_version;
    return (revision === undefined ? options.kernel.latestRevision(graphId) : options.kernel.revision(graphId, revision))?.definition.nodes[nodeId];
  };
  /** Use the execution's frozen location, including publication during a concurrent patch. */
  const nodeLocation = (graphId: string, nodeId: string, revisionVersion?: number): { workspace: string; base: 'project' | 'worktree' } | undefined => {
    const node = nodeDefinition(graphId, nodeId, revisionVersion);
    const selected = node?.workspace?.base ?? 'auto';
    const admitted = options.kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string } | undefined;
    const copy = selected !== 'project' && options.git && admitted?.instance_id
      ? options.git.workspace(graphId, admitted.instance_id, nodeId, 'agent', 'work') : undefined;
    if (selected === 'worktree' && !copy) throw new RuntimeError('invalid_workspace', 'Node requests a worktree; prepare this graph with a targetBranch first');
    const base = copy ?? options.workspaceFor(graphId);
    if (!base) return undefined;
    try {
      const root = realpathSync(base); const workspace = realpathSync(resolve(root, node?.workspace?.path ?? '.'));
      const within = relative(root, workspace);
      if (within === '..' || within.startsWith('../') || within.startsWith('/')) throw new RuntimeError('permission', 'Node workspace path escapes its declared base');
      if (!statSync(workspace).isDirectory()) throw new RuntimeError('invalid_workspace', 'Node workspace path must be an existing directory');
      return { workspace, base: copy ? 'worktree' : 'project' };
    } catch (error) {
      if (error instanceof RuntimeError) throw error;
      throw new RuntimeError('invalid_workspace', `Node workspace cannot be opened: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const nodeWorkspace = (graphId: string, nodeId: string, revisionVersion?: number) => nodeLocation(graphId, nodeId, revisionVersion)?.workspace;
  const nodeAccess = (graphId: string, nodeId: string, revisionVersion: number) => nodeAccessPolicy(
    nodeDefinition(graphId, nodeId, revisionVersion)?.access,
    options.access?.() ?? resolveAccessPolicy(standardAccessPolicy(), { stateDir: options.stateDir, ...(options.graphHome ? { graphHome: options.graphHome } : {}) }),
    { stateDir: options.stateDir, ...(options.graphHome ? { graphHome: options.graphHome } : {}) });

  const sessionFor = async (graphId: string, nodeId: string, revisionVersion: number): Promise<NodeSessionRequest> => {
    if (closing) throw new Error('Graph runtime is closing');
    const key = `${graphId}/${nodeId}`;
    const cached = sessions.get(key);
    const revision = options.kernel.revision(graphId, revisionVersion);
    if (!revision) throw new Error(`graph ${graphId} has no revision to run`);
    const recipe = revision.definition.nodes[nodeId]?.recipe;
    const role = recipe && options.catalog.definition(recipe).review === true ? 'reviewer' : 'worker';
    const prompts = options.library ? await Promise.all([
      options.library.prompt('rules/common.md'), options.library.prompt(`rules/${role}.md`),
      options.library.prompt(`tools/${role}.md`), options.library.prompt('runtime/node.md'),
      options.library.agentPrompt(recipe?.split('@')[0] ?? nodeId, null),
    ]) : null;
    const location = nodeLocation(graphId, nodeId, revisionVersion);
    const workspace = location?.workspace;
    if (!workspace) throw new RuntimeError('invalid_workspace', `graph ${graphId} node ${nodeId} has no workspace`);
    const access = nodeAccess(graphId, nodeId, revisionVersion);
    const configuration = JSON.stringify({ recipe, prompts, workspace, access, network: options.network });
    if (cached && sessionRevisions.get(key) === configuration) return cached;
    if (cached) { await hosts.get(key)?.stop(); hosts.delete(key); await cached.close(); }
    const domains = options.network?.retrievalDomains ?? [];
    const unrestricted = access.network === 'unrestricted';
    const retrieval = domains.length || unrestricted ? createRetrievalBroker({ domains, unrestricted,
      gate: kernelToolGate(options.kernel, graphId, nodeId, 'retrieval', () => closing),
    }) : undefined;
    const session = await nodeSessionRequest({
      retainCapabilities: true,
      gate: options.gateFor?.(graphId, nodeId) ?? kernelToolGate(options.kernel, graphId, nodeId, 'tool', () => closing),
      access,
      kernel: options.kernel,
      catalog: options.catalog,
      ...(options.library ? { library: options.library } : {}),
      graphId,
      nodeId,
      revisionVersion: revision.version,
      workspace,
      bindings: {
        ...(retrieval ? { fetch: (url: string, signal?: AbortSignal) => retrieval.fetch(url, signal) } : {}),
        ...(options.git && options.kernel.store.task(graphId).integration_branch && location?.base === 'worktree' && role !== 'reviewer' ? {
          commitWorkspace: async (input: { paths: string[]; message: string }) => options.git!.exclusive(graphId, () => {
            const task = options.kernel.store.task(graphId);
            const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
            if (!execution || closing || task.paused || options.kernel.nodeState(graphId, nodeId).paused || ['stopping', 'stopped', 'completed'].includes(task.phase)) throw new RuntimeError('paused', 'Workspace commit is closed');
            const unknown = options.kernel.db.prepare("SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state='unknown' LIMIT 1").get(graphId, nodeId);
            if (unknown && options.kernel.execution(execution.id)?.tokenBudget?.unlimited !== true) throw new RuntimeError('budget', 'Reconcile unknown provider usage before committing work');
            const admitted = options.kernel.listNodes(graphId).find(node => node.nodeId === nodeId)!;
            return options.git!.commitWorkspace({ ...input, id: execution.id, taskId: graphId, nodeId, instanceId: admitted.instanceId, recipe: recipe!, workspace });
          }),
        } : {}),
        peers: {
          list: async () => [...Object.keys(options.kernel.latestRevision(graphId)!.definition.nodes).map(id => ({ id, href: `graph://${graphId}/agents/${encodeURIComponent(id)}` })), { id: 'main', href: `graph://${graphId}/owner` }],
          send: async message => {
            if (message.to === 'main') {
              if (!options.onMainMessage) throw new Error('Main agent message channel unavailable');
              return options.onMainMessage(graphId, nodeId, message);
            }
            return sendKernelNodeMessage(options.kernel, graphId, message.to, message, nodeId);
          },
        },
        ...(options.artifacts ? { artifacts: {
          allowedNamespaces: ['plans', 'research', 'reviews', 'deliverables', 'summaries'], canPromote: false,
          list: query => options.artifacts!.list({ taskId: graphId, ...query }),
          get: (id, version) => options.artifacts!.get(graphId, id, version),
          read: (id, version, maxBytes) => options.artifacts!.read(graphId, id, version, maxBytes),
          retire: (id, version, reason, requestId) => {
            const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
            if (!execution) throw new Error('No active execution');
            const admitted = options.kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string };
            return options.artifacts!.retire(graphId, id, version, reason, requestId, { nodeId, instanceId: admitted.instance_id, operationId: execution.id, activationId: execution.id });
          },
          publish: async input => {
            const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
            if (!execution) throw new Error('No active execution');
            return options.artifacts!.publish({ ...input, taskId: graphId, workspace,
              producer: { nodeId, instanceId: (options.kernel.db.prepare('SELECT instance_id FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graphId, nodeId) as { instance_id: string }).instance_id, operationId: execution.id, activationId: execution.id } });
          },
        } } : {}),
      },
      instancesDir: options.instancesDir,
    });
    if (closing) { await session.close(); throw new Error('Graph runtime is closing'); }
    session.environment = { revision: revisionVersion, workspace, base: location!.base, access };
    session.systemPrompt += `\n\nNODE WORKING ENVIRONMENT\n${JSON.stringify({ workspace, base: session.environment.base, access })}`;
    if (cached) options.kernel.store.event(graphId, 'graph.node.rebound', { nodeId, revision: revisionVersion,
      previousRecipe: cached.binding.definitionVersion, recipe: session.binding.definitionVersion,
      previousWorkspace: cached.environment?.workspace ?? null, workspace,
      previousAccessDigest: cached.environment?.access.digest ?? null, accessDigest: access.digest });
    sessions.set(key, session);
    sessionRevisions.set(key, configuration);
    if (session.operation) recordCapabilityLoad(options.kernel.store, { taskId: graphId, nodeId, instanceId: session.binding.instanceId,
      readOnly: false, report: session.operation.report, digest: session.bundleDigest, toolPolicyDigest: session.toolPolicyDigest, runtimePolicyDigest: session.runtimePolicyDigest });
    return session;
  };

  return new GraphLane({
    finalize: async graphId => {
      if (!options.git || !options.kernel.store.task(graphId).integration_branch) return;
      await options.git.exclusive(graphId, () => {
        if (closing || ['stopping', 'stopped', 'completed'].includes(options.kernel.store.task(graphId).phase)) return;
        const acceptance = graphAcceptance(options.kernel, graphId, options.artifacts);
        if (!acceptance.ready || !acceptance.commit) return;
        const result = options.git!.tryDeliver(graphId, acceptance.commit);
        if (result.status === 'merged') options.kernel.db.prepare('INSERT INTO kernel_completion_delivery(task_id,commit_sha,created_at) VALUES(?,?,?) ON CONFLICT(task_id) DO UPDATE SET commit_sha=excluded.commit_sha,created_at=excluded.created_at')
          .run(graphId, acceptance.commit, Date.now());
        else options.kernel.store.event(graphId, 'graph.delivery.pending', {
          status: result.status, commit: acceptance.commit, detail: result.data ?? null,
        });
      });
    },
    settleWorkspace: async executionId => {
      const execution = options.kernel.execution(executionId);
      if (!execution || !options.git || !options.kernel.store.task(execution.taskId).integration_branch) return;
      if (closing || ['stopping', 'stopped'].includes(options.kernel.store.task(execution.taskId).phase)) throw new RuntimeError('paused', 'Git integration is closed');
      const node = options.kernel.revision(execution.taskId, execution.revisionVersion)!.definition.nodes[execution.nodeId]!;
      const known = options.catalog.hasDefinition(node.recipe);
      // Reviewer reports are shared artifacts; they must not become implementation changes.
      if (known && options.catalog.definition(node.recipe!).review === true) return;
      const admitted = options.kernel.listNodes(execution.taskId).find(candidate => candidate.nodeId === execution.nodeId)!;
      const result = await options.git.exclusive(execution.taskId, () => options.git!.integrate({
        id: execution.id, taskId: execution.taskId, nodeId: execution.nodeId, instanceId: admitted.instanceId, kind: 'agent', recipe: node.recipe,
      }));
      if (result && !result.ok) throw new RuntimeError('git_conflict', `Git integration refused: ${result.conflicts.join(', ')}. Inspect the worktree and integration tip before retrying.`);
    },
    operation: async (graphId, request) => {
      const execute = () => {
        const workspace = options.git?.workspace(graphId, null, request.moduleId, 'program', 'graph.command') ?? options.workspaceFor(graphId);
        if (!workspace) throw new Error('Operation module has no workspace');
        return executeModuleOperation({ ...request, graphId, kernel: options.kernel, workspace, scratchRoot: options.stateDir,
          // The same facts settleWorkspace uses decide whether this delivery's source owes the
          // integration branch a commit, so a check never waits on a source that never integrates.
          integratesSource: executionId => {
            const execution = options.kernel.execution(executionId);
            if (!execution) return false;
            const node = options.kernel.revision(execution.taskId, execution.revisionVersion)?.definition.nodes[execution.nodeId];
            if (!node) return false;
            if (options.catalog.hasDefinition(node.recipe) && options.catalog.definition(node.recipe!).review === true) return false;
            const admitted = options.kernel.listNodes(execution.taskId).find(candidate => candidate.nodeId === execution.nodeId);
            return Boolean(admitted?.instanceId);
          },
          program: { ...options.program, nodeModulesPath: options.program?.nodeModulesPath
            ?? join(options.workspaceFor(graphId) ?? workspace, 'node_modules') },
          ...(options.access ? { access: options.access() } : {}) });
      };
      // A check observes one integration tip; managed merges cannot race its receipt.
      return options.git ? options.git.exclusive(graphId, execute) : execute();
    },
    closeGraph: async graphId => {
      for (const key of [...hosts.keys()]) {
        if (!key.startsWith(`${graphId}/`)) continue;
        await hosts.get(key)!.dispose(); hosts.delete(key); hostConfigs.delete(key); boundModels.delete(key);
        await sessions.get(key)?.close(); sessions.delete(key); sessionRevisions.delete(key);
      }
    },
    close: async () => {
      closing = true;
      await Promise.all([...hosts.values()].map(host => host.dispose()));
      hosts.clear();
      await Promise.all([...sessions.values()].map(session => session.close()));
      sessions.clear();
      sessionRevisions.clear();
      hostConfigs.clear();
      boundModels.clear();
    },
    kernel: options.kernel,
    ...(options.tokenBudget && options.reserveTokens !== undefined
      ? { tokenBudget: options.tokenBudget, reserveTokens: options.reserveTokens } : {}),
    // A node's declared deliverable is settled from its own work copy into the shared
    // artifact store, so work the node produced is published without a tool call (§13.8).
    workspace: nodeWorkspace,
    ...(options.artifacts ? { artifacts: () => options.artifacts } : {}),
    // The worker config: the node's own session plus the credential the host resolved.
    config: async (graphId, nodeId, revisionVersion) => {
      const session = await sessionFor(graphId, nodeId, revisionVersion);
      const recipe = session.binding.definitionVersion;
      const model = modelFor(options, recipe, { graphId, nodeId, revisionVersion });
      if (!model) throw new RuntimeError('model_selection', `No eligible configured model for recipe ${recipe}; review excludes recorded implementer models`);
      boundModels.set(`${graphId}/${nodeId}`, structuredClone(model));
      const credential = options.credentialFor(model);
      if (!credential) throw new Error(`no credential bound for model ${model.id}`);
      const workspace = session.environment!.workspace;
      options.kernel.db.prepare('INSERT INTO kernel_node_bindings(task_id,node_id,model_id,system_prompt,tools,state_dir,role,environment) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(task_id,node_id) DO UPDATE SET model_id=excluded.model_id,system_prompt=excluded.system_prompt,tools=excluded.tools,state_dir=excluded.state_dir,role=excluded.role,environment=excluded.environment')
        .run(graphId, nodeId, model.id, session.systemPrompt, JSON.stringify(session.allowedToolNames), session.stateDir, session.role, JSON.stringify({ ...session.environment, revision: revisionVersion }));
      return {
        binding: session.binding,
        allowWorkspaceChange: true,
        workspace,
        stateDir: session.stateDir,
        model: toPiModel(model),
        thinkingLevel: 'off',
        compaction: compactionSettings(model),
        // §5: the node's graph output tool is `submit`. The host executes the call against the
        // real execution (HB-262), so the model can never forge an executionId.
        tools: [...(session.operation?.tools ?? []).map(tool => ({
          name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
        })), {
          name: 'submit', label: 'Submit',
          // The argument shape is part of the contract, not a detail the model has to guess: a
          // call that puts its outputs anywhere else is refused by name (HB-324).
          description: 'Submit this node\'s required outputs to the graph kernel. Call it as {"outputs":{"<output name>":{"enable":true,"value":<value>}}}; every required output must appear with enable:true.',
          parameters: {
            type: 'object',
            properties: {
              outputs: {
                type: 'object',
                description: 'One entry per output this node declares; enable:true for the required ones.',
                additionalProperties: {
                  type: 'object',
                  properties: { enable: { type: 'boolean' }, value: {} },
                  required: ['enable'],
                },
              },
            },
            required: ['outputs'],
          } as never,
        }],
        nativeTools: [...(session.operation?.nativeTools ?? [])],
        skillPaths: [...(session.operation?.skillPaths ?? [])],
        ...(session.operation?.skillFolder ? { skillFolder: session.operation.skillFolder } : {}),
        piExtensionPaths: [...(session.operation?.piExtensionPaths ?? [])],
        piExtensionTools: [...(session.operation?.piExtensionTools ?? [])],
        mcpAdapterServers: [...(session.operation?.mcpAdapterServers ?? [])],
        systemPrompt: session.systemPrompt,
        allowedToolNames: ['submit', ...session.allowedToolNames.filter(name => name !== 'submit')],
        bundleDigest: session.bundleDigest,
        toolPolicyDigest: session.toolPolicyDigest,
        runtimePolicyDigest: session.runtimePolicyDigest,
        // Provider calls are executed by the host; credentials never enter this file.
        hostModel: true,
      };
    },
    // One resident process per node, reused across turns.
    host: async (graphId: string, nodeId: string, config: unknown) => {
      const key = `${graphId}/${nodeId}`;
      const cached = hosts.get(key);
      const signature = JSON.stringify(config);
      if (cached && hostConfigs.get(key) === signature) return cached;
      if (cached) await cached.stop();
      await mkdir(join(options.stateDir, 'kernel-worker'), { recursive: true });
      const configPath = join(options.stateDir, 'kernel-worker', `${encodeURIComponent(graphId)}-${encodeURIComponent(nodeId)}.json`);
      const session = sessions.get(key);
      if (!session) throw new Error('Resident host has no prepared session');
      const workspace = session.environment!.workspace;
      if (closing) throw new Error('Graph runtime is closing');
      if (!session.operation) throw new Error('Resident node has no resolved capability operation');
      const model = boundModels.get(key);
      if (!model || model.id !== (config as { model: { name: string } }).model.name) throw new Error('Resident host has no prepared model connection');
      let purpose: 'completion' | 'compaction' = 'completion';
      const nativeGate = kernelToolGate(options.kernel, graphId, nodeId, 'tool', () => closing);
      const nativeCalls = new Map<string, string>();
      const host = new ResidentHost({
        launch: residentLauncher({ config: config as never, configPath, workerEntry, operation: session.operation,
          access: session.environment!.access }),
        workerEntry,
        cwd: workspace,
        configPath,
        config: config as never,
        onModelCall: async (raw, hostSignal) => {
          const credential = options.credentialFor(model);
          if (!credential) throw new Error('Bound model credential unavailable');
          const context = raw as Context;
          if (!context || !Array.isArray(context.messages)) throw new Error('Invalid model context');
          let usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
          let unknown = false;
          let refusal: RuntimeError | undefined;
          const gate = kernelProviderGate(options.kernel, graphId, nodeId, undefined, model,
            { definition: session.binding.definitionVersion, review: session.role === 'reviewer' }, purpose);
          const observed: SendGate = {
            dispatch: (id, reservation, send) => {
              try { return gate.dispatch(id, reservation, send); }
              catch (error) {
                if (error instanceof RuntimeError && (error.code === 'paused' || error.code === 'budget')) refusal = error;
                throw error;
              }
            },
            settle: (id, cost) => { gate?.settle(id, cost); if (cost) {
              for (const name of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) usage[name] += cost[name];
            } else unknown = true; },
          };
          const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
          if (!execution) throw new Error('No active execution');
          const abort = new AbortController();
          const cancel = () => abort.abort();
          hostSignal.addEventListener('abort', cancel, { once: true });
          const unsubscribe = options.kernel.store.onEvent(() => { if (options.kernel.store.task(graphId).phase === 'stopping') abort.abort(); });
          const slot = options.scheduler && (credential.limit !== undefined || credential.groupLimit !== undefined) ? {
            acquire: async (signal?: AbortSignal) => {
              setNativeExecutionWaiting(options.kernel.store, execution.id, true);
              let release: (() => void) | undefined;
              try {
                const request = () => {
                  const binding = options.credentialFor(model);
                  if (!binding) throw new Error('Bound model credential unavailable');
                  return { ...binding, credentialId: binding.credentialId ?? model.provider };
                };
                for (;;) {
                  const before = request();
                  release = await options.scheduler!.acquire({ ...before, refresh: request }, signal);
                  const after = request();
                  if (before.credentialId === after.credentialId && before.apiKey === after.apiKey) break;
                  release(); release = undefined;
                }
                await waitForKernelExecutionSlot(options.kernel.store, execution.id, signal);
                return release!;
              } catch (error) {
                release?.();
                setNativeExecutionWaiting(options.kernel.store, execution.id, false);
                throw error;
              }
            },
          } : undefined;
          try {
          const stream = await controlledOpenAIStream(observed, () => { const binding = options.credentialFor(model); if (!binding) throw new Error('Bound model credential unavailable'); return binding.apiKey; }, slot, model.api, {
            estimateMissing: options.kernel.execution(execution.id)?.tokenBudget?.unlimited === true,
            onSend: prompt => options.kernel.db.prepare('INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)')
              .run(graphId, nodeId, (options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined)?.id ?? null,
                prompt.systemPrompt ?? '', prompt.toolDeclarations ?? '[]', Date.now()),
          })(toPiModel(model), normalizeContext(context), { signal: abort.signal });
          const frames = await encodeAssistantStream(stream);
          const settlement = await stream.result();
          // Provider SDKs wrap gate refusals as connection errors. Preserve the
          // host's control reason so pause cannot consume automatic retries.
          if (refusal && settlement.stopReason === 'error') settlement.errorMessage = refusal.message;
          return { frames, settlement, ...(!unknown ? { usage: { ...usage, total: tokenUsageTotal(usage), accounted: true } } : {}) };
          } finally { unsubscribe(); hostSignal.removeEventListener('abort', cancel); }
        },
        onReady: inspect => recordNodeSession(options.kernel.store, (config as { binding: { instanceId: string } }).binding.instanceId, inspect.sessionId, inspect.sessionFile ?? null),
        // The node's `submit` runs in the host, over the real execution (HB-262): the lane
        // wires that through `onToolCall` when it builds the runner.
        onEvent: event => {
          const data = event as { type: string; message?: { role: string; content: unknown }; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown; isError?: boolean; systemPrompt?: string; tools?: unknown };
          const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
          if (data.type === 'compaction_start') {
            purpose = 'compaction';
            options.kernel.store.event(graphId, 'session.compaction_started', { nodeId, operationId: execution?.id ?? null });
          }
          if (data.type === 'compaction_end') {
            purpose = 'completion';
            const result = (event as { aborted?: boolean; result?: { summary: string; tokensBefore?: number }; errorMessage?: string });
            if (!result.aborted && result.result) {
              appendNodeEntry(options.kernel.store, { taskId: graphId, nodeId, operationId: execution?.id ?? null,
                role: 'system', kind: 'compaction', text: result.result.summary });
              options.kernel.store.event(graphId, 'session.compacted', { nodeId, operationId: execution?.id ?? null, tokensBefore: result.result.tokensBefore ?? null });
            } else options.kernel.store.event(graphId, 'session.compaction_failed', { nodeId, operationId: execution?.id ?? null, error: result.errorMessage ?? 'compaction aborted' });
          }
          if (data.type === 'graph_provider_prompt') {
            options.kernel.db.prepare('INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)')
              .run(graphId, nodeId, execution?.id ?? null, data.systemPrompt ?? '', typeof data.tools === 'string' ? data.tools : JSON.stringify(data.tools ?? []), Date.now());
          }
          if (data.type === 'message_end' && data.message?.role === 'assistant') {
            const content = data.message.content;
            const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map(part => part.text ?? '').join('') : '';
            if (text) appendNodeEntry(options.kernel.store, { taskId: graphId, nodeId, operationId: execution?.id ?? null, role: 'assistant', kind: 'message', text });
          }
          if (data.type === 'tool_execution_start' || data.type === 'tool_execution_end') {
            const call = data.type === 'tool_execution_start';
            const reason = !call && data.isError ? toolResultText(data.result) : '';
            appendNodeEntry(options.kernel.store, { taskId: graphId, nodeId, operationId: execution?.id ?? null, role: 'tool', kind: call ? 'call' : 'result',
              text: reason ? `工具执行失败：${reason.slice(0, 400)}` : JSON.stringify(call ? { name: data.toolName, args: data.args } : data.result),
              data: { toolName: data.toolName ?? '', toolCallId: data.toolCallId ?? '', isError: data.isError ?? false, ...(reason ? { message: reason } : {}) } });
          }
        },
        onToolCall: async (name, args) => {
          if (name === 'native_tool_start' || name === 'native_tool_settle') {
            const call = args as { id?: string; name?: string };
            if (!call || typeof call.id !== 'string' || !call.id || !session.operation?.nativeTools.includes(call.name ?? '')) return { ok: false, text: 'Unknown native tool admission' };
            try {
              if (name === 'native_tool_start') {
                if (nativeCalls.has(call.id)) throw new Error('Native tool already admitted');
                const id = randomUUID();
                nativeGate.dispatch(id, 0, () => undefined);
                nativeCalls.set(call.id, id);
              } else {
                const id = nativeCalls.get(call.id);
                if (!id) throw new Error('Native tool has no admission');
                nativeGate.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
                nativeCalls.delete(call.id);
              }
              return { ok: true, text: 'ok' };
            } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
          }
          const tool = sessions.get(key)?.operation?.tools.find(tool => tool.name === name);
          if (!tool) return options.onToolCall?.(graphId, nodeId, name, args) ?? { ok: false, text: `the host does not offer a tool named ${name}` };
          try {
            const id = randomUUID();
            const result = await nativeGate.dispatch(id, 0, async () => {
              try { return await tool.execute(id, args as never, new AbortController().signal, undefined, undefined as never); }
              finally { nativeGate.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); }
            });
            return { ok: !('isError' in result && result.isError), text: JSON.stringify(result) };
          } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
        },
      });
      hosts.set(key, host);
      hostConfigs.set(key, signature);
      return host;
    },

  });
}
