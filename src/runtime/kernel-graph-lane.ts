import { executeModuleOperation } from './kernel-operation-broker.ts';
import { waitForKernelExecutionSlot } from './execution-slots.ts';
import type { ModelScheduler } from './model-scheduler.ts';
import { RuntimeError } from '../core/types.ts';
import { randomUUID } from 'node:crypto';
import type { AgentContextLibrary } from './agent-context.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import type { KernelStore } from '../core/kernel-store.ts';
import type { Catalog } from '../catalog/catalog.ts';
import { modelIdentity, type ModelEntry } from '../catalog/models.ts';
import { appendNodeEntry, recordCapabilityLoad, recordNodeSession } from '../core/node-run.ts';
import { GraphRuntime } from '../core/graph-runtime.ts';
import { GraphLane } from '../core/graph-lane.ts';
import type { RunnerHost } from '../core/graph-runner.ts';
import type { ArtifactWorkspace } from '../core/artifact-workspace.ts';
import { residentLauncher } from './resident-launcher.ts';
import { ResidentHost } from './resident-host.ts';
import { nodeSessionRequest, type NodeSessionRequest } from './kernel-node-host.ts';
import { toPiModel } from './pi-adapter.ts';
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
  catalog: Catalog;
  library?: AgentContextLibrary;
  /**
   * §9: the token budget a node runs under. Absent means unmetered - which is the right
   * default for a program node, but NOT for an agent that can spend real tokens, so the
   * runtime supplies one whenever limits are configured.
   */
  tokenBudget?: { budget: number; unlimited: boolean };
  reserveTokens?: number;
  /** The models the runtime is configured with. */
  directory: () => ModelEntry[];
  /** Resolve the credential for a model entry; undefined means the node cannot run. */
  scheduler?: ModelScheduler;
  credentialFor: (entry: ModelEntry) => { apiKey: string; credentialId?: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
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
  onMainMessage?: (graphId: string, nodeId: string, text: string) => Promise<unknown>;
  onToolCall?: (graphId: string, nodeId: string, name: string, args: unknown) => { ok: boolean; text: string } | Promise<{ ok: boolean; text: string }>;
  /**
   * A scripted stand-in for a node's real Pi process.
   *
   * §7's lane is otherwise unreachable without a configured model and credential: `config`
   * resolves a real session and `host` starts a real resident process. That is right in
   * production and useless in a test - most of the suite drives nodes through a scripted
   * ActionAdapter and configures no model at all, so a v2 graph could be created but never
   * ran. This seam lets a test run a v2 graph end to end without inventing a provider.
   *
   * It is deliberately NOT a second execution path: the scripted host submits through the
   * same `onToolCall` and the same NodeSubmitBridge, so the kernel settles the submission,
   * checks the required outputs and advances the graph exactly as a real turn would. Only
   * the process that produces the tool call is replaced.
   */
  scriptedTurn?: (graphId: string, nodeId: string, text: string, turn: number, workspace?: string) =>
    { outputs?: Record<string, { enable?: boolean; value?: unknown }>; missing?: string[] } | Promise<{ outputs?: Record<string, { enable?: boolean; value?: unknown }>; missing?: string[] }>;
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
  const requested = context && options.kernel.revision(context.graphId, context.revisionVersion)?.definition.nodes[context.nodeId]?.model?.trim();
  return directory.find(model => model.id === requested) ?? directory.find(model => model.grade === entry.recommendedGrade) ?? directory[0];
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
    const configuration = JSON.stringify({ recipe, prompts, access: options.access?.() });
    if (cached && sessionRevisions.get(key) === configuration) return cached;
    if (cached) { await hosts.get(key)?.stop(); hosts.delete(key); await cached.close(); }
    const workspace = nodeWorkspace(graphId, nodeId);
    if (!workspace) throw new Error(`graph ${graphId} node ${nodeId} has no workspace`);
    const session = await nodeSessionRequest({
      retainCapabilities: true,
      ...(options.access ? { access: options.access() } : {}),
      kernel: options.kernel,
      catalog: options.catalog,
      ...(options.library ? { library: options.library } : {}),
      graphId,
      nodeId,
      revisionVersion: revision.version,
      workspace,
      bindings: {
        ...(options.git && options.kernel.store.task(graphId).integration_branch && role !== 'reviewer' ? {
          commitWorkspace: async (input: { paths: string[]; message: string }) => options.git!.exclusive(graphId, () => {
            const task = options.kernel.store.task(graphId);
            const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
            if (!execution || closing || task.paused || options.kernel.nodeState(graphId, nodeId).paused || ['stopping', 'stopped', 'completed'].includes(task.phase)) throw new RuntimeError('paused', 'Workspace commit is closed');
            const unknown = options.kernel.db.prepare("SELECT 1 FROM kernel_provider_calls WHERE task_id=? AND node_id=? AND state='unknown' LIMIT 1").get(graphId, nodeId);
            if (unknown) throw new RuntimeError('budget', 'Reconcile unknown provider usage before committing work');
            const admitted = options.kernel.listNodes(graphId).find(node => node.nodeId === nodeId)!;
            return options.git!.commitWorkspace({ ...input, id: execution.id, taskId: graphId, nodeId, instanceId: admitted.instanceId, recipe: recipe!, workspace });
          }),
        } : {}),
        peers: {
          list: async () => [...Object.keys(options.kernel.latestRevision(graphId)!.definition.nodes).map(id => ({ id, href: `graph://${graphId}/agents/${encodeURIComponent(id)}` })), { id: 'main', href: `graph://${graphId}/owner` }],
          send: async message => {
            if (message.to === 'main') {
              if (!options.onMainMessage) throw new Error('Main agent message channel unavailable');
              return options.onMainMessage(graphId, nodeId, message.text);
            }
            return new GraphRuntime(options.kernel, graphId).chat({ nodeId: message.to, text: `From ${nodeId}: ${message.text}` }, true);
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
      ...(options.gateFor?.(graphId, nodeId) ? { gate: options.gateFor(graphId, nodeId)! } : {}),
    });
    if (closing) { await session.close(); throw new Error('Graph runtime is closing'); }
    sessions.set(key, session);
    sessionRevisions.set(key, configuration);
    if (session.operation) recordCapabilityLoad(options.kernel.store, { taskId: graphId, nodeId, instanceId: session.binding.instanceId,
      readOnly: false, report: session.operation.report, digest: session.bundleDigest, toolPolicyDigest: session.toolPolicyDigest, runtimePolicyDigest: session.runtimePolicyDigest });
    return session;
  };

  const turns = new Map<string, number>();
  const scriptedHost = (graphId: string, nodeId: string): RunnerHost => ({
    start: async () => ({ processId: 0 }),
    alive: () => true,
    turn: async (text: string) => {
      const key = `${graphId}/${nodeId}`;
      const turn = (turns.get(key) ?? 0) + 1;
      turns.set(key, turn);
      const scripted = await options.scriptedTurn!(graphId, nodeId, text, turn, nodeWorkspace(graphId, nodeId));
      // The submission travels the real path: onToolCall -> NodeSubmitBridge -> kernel.
      const result = options.onToolCall
        ? await options.onToolCall(graphId, nodeId, 'submit', { outputs: scripted.outputs ?? {} })
        : { ok: false, text: 'the lane has no tool channel' };
      // A scripted turn still costs something, and must say so: HB-289 holds a metered turn
      // that reports no usage, so a scripted host that stayed silent would park every node
      // it was meant to drive. Zero is the honest figure - the script spends no tokens.
      return {
        turnId: `scripted-${nodeId}-${turn}`,
        inspect: { ...result, missing: scripted.missing ?? [] },
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      };
    },
  });

  return new GraphLane({
    settleWorkspace: async executionId => {
      const execution = options.kernel.execution(executionId);
      if (!execution || !options.git || !options.kernel.store.task(execution.taskId).integration_branch) return;
      if (closing || ['stopping', 'stopped'].includes(options.kernel.store.task(execution.taskId).phase)) throw new RuntimeError('paused', 'Git integration is closed');
      const node = options.kernel.revision(execution.taskId, execution.revisionVersion)!.definition.nodes[execution.nodeId]!;
      const known = options.catalog.listDefinitions().some(recipe => `${recipe.id}@${recipe.version}` === node.recipe);
      // Reviewer reports are shared artifacts; they must not become implementation changes.
      if (known && options.catalog.definition(node.recipe!).review === true) return;
      const admitted = options.kernel.listNodes(execution.taskId).find(candidate => candidate.nodeId === execution.nodeId)!;
      const result = await options.git.exclusive(execution.taskId, () => options.git!.integrate({
        id: execution.id, taskId: execution.taskId, nodeId: execution.nodeId, instanceId: admitted.instanceId, kind: 'agent',
      }));
      if (result && !result.ok) throw new RuntimeError('git_conflict', `Git integration refused: ${result.conflicts.join(', ')}. Inspect the worktree and integration tip before retrying.`);
    },
    operation: async (graphId, request) => {
      const execute = () => {
        const workspace = options.git?.workspace(graphId, null, request.moduleId, 'program', 'graph.command') ?? options.workspaceFor(graphId);
        if (!workspace) throw new Error('Operation module has no workspace');
        return executeModuleOperation({ ...request, graphId, kernel: options.kernel, workspace, scratchRoot: options.stateDir,
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
      const workspace = nodeWorkspace(graphId, nodeId) ?? options.stateDir;
      options.kernel.db.prepare('INSERT INTO kernel_node_bindings(task_id,node_id,model_id,system_prompt,tools,state_dir,role) VALUES(?,?,?,?,?,?,?) ON CONFLICT(task_id,node_id) DO UPDATE SET model_id=excluded.model_id,system_prompt=excluded.system_prompt,tools=excluded.tools,state_dir=excluded.state_dir,role=excluded.role')
        .run(graphId, nodeId, model.id, session.systemPrompt, JSON.stringify(session.allowedToolNames), session.stateDir, session.role);
      return {
        binding: session.binding,
        workspace,
        stateDir: session.stateDir,
        model: toPiModel(model),
        thinkingLevel: 'off',
        // §5: the node's graph output tool is `submit`. The host executes the call against the
        // real execution (HB-262), so the model can never forge an executionId.
        tools: [...(session.operation?.tools ?? []).map(tool => ({
          name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters,
        })), {
          name: 'submit', label: 'Submit',
          description: 'Submit this node required outputs through the graph kernel.',
          parameters: { type: 'object' } as never,
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
      const workspace = nodeWorkspace(graphId, nodeId) ?? options.stateDir;
      const configPath = join(options.stateDir, 'kernel-worker', `${encodeURIComponent(graphId)}-${encodeURIComponent(nodeId)}.json`);
      const session = sessions.get(key);
      if (!session) throw new Error('Resident host has no prepared session');
      if (closing) throw new Error('Graph runtime is closing');
      if (!session.operation) throw new Error('Resident node has no resolved capability operation');
      const model = boundModels.get(key);
      if (!model || model.id !== (config as { model: { name: string } }).model.name) throw new Error('Resident host has no prepared model connection');
      const host = new ResidentHost({
        launch: residentLauncher({ config: config as never, configPath, workerEntry, operation: session.operation,
          ...(options.access ? { access: options.access() } : {}) }),
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
          const gate = kernelProviderGate(options.kernel, graphId, nodeId, options.tokenBudget, model);
          const observed: SendGate = {
            dispatch: (id, reservation, send) => gate.dispatch(id, reservation, send),
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
              options.kernel.db.prepare('UPDATE kernel_executions SET waiting_slot=1 WHERE id=?').run(execution.id);
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
                options.kernel.db.prepare('UPDATE kernel_executions SET waiting_slot=0 WHERE id=?').run(execution.id);
                throw error;
              }
            },
          } : undefined;
          try {
          const stream = await controlledOpenAIStream(observed, () => { const binding = options.credentialFor(model); if (!binding) throw new Error('Bound model credential unavailable'); return binding.apiKey; }, slot, model.api, {
            onSend: prompt => options.kernel.db.prepare('INSERT INTO kernel_prompts(task_id,node_id,execution_id,system_prompt,tools,created_at) VALUES(?,?,?,?,?,?)')
              .run(graphId, nodeId, (options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined)?.id ?? null,
                prompt.systemPrompt ?? '', prompt.toolDeclarations ?? '[]', Date.now()),
          })(toPiModel(model), normalizeContext(context), { signal: abort.signal });
          const frames = await encodeAssistantStream(stream);
          const settlement = await stream.result();
          return { frames, settlement, ...(!unknown ? { usage: { ...usage, total: tokenUsageTotal(usage), accounted: true } } : {}) };
          } finally { unsubscribe(); hostSignal.removeEventListener('abort', cancel); }
        },
        onReady: inspect => recordNodeSession(options.kernel.store, (config as { binding: { instanceId: string } }).binding.instanceId, inspect.sessionId, inspect.sessionFile ?? null),
        // The node's `submit` runs in the host, over the real execution (HB-262): the lane
        // wires that through `onToolCall` when it builds the runner.
        onEvent: event => {
          const data = event as { type: string; message?: { role: string; content: unknown }; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown; isError?: boolean; systemPrompt?: string; tools?: unknown };
          const execution = options.kernel.db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id=? AND state='running' ORDER BY rowid DESC LIMIT 1").get(graphId, nodeId) as { id: string } | undefined;
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
            appendNodeEntry(options.kernel.store, { taskId: graphId, nodeId, operationId: execution?.id ?? null, role: 'tool', kind: call ? 'call' : 'result',
              text: JSON.stringify(call ? { name: data.toolName, args: data.args } : data.result),
              data: { toolName: data.toolName ?? '', toolCallId: data.toolCallId ?? '', isError: data.isError ?? false } });
          }
        },
        onToolCall: async (name, args) => {
          const tool = sessions.get(key)?.operation?.tools.find(tool => tool.name === name);
          if (!tool) return options.onToolCall?.(graphId, nodeId, name, args) ?? { ok: false, text: `the host does not offer a tool named ${name}` };
          try {
            const result = await tool.execute(randomUUID(), args as never, new AbortController().signal, undefined, undefined as never);
            return { ok: !('isError' in result && result.isError), text: JSON.stringify(result) };
          } catch (error) { return { ok: false, text: error instanceof Error ? error.message : String(error) }; }
        },
      });
      hosts.set(key, host);
      hostConfigs.set(key, signature);
      return host;
    },
    // The scripted stand-ins go LAST so they win: `config` above resolves a real session
    // and throws without a configured model, which is exactly what a scripted node must
    // not need. Spreading them earlier would be silently overridden by the real ones.
    ...(options.scriptedTurn ? {
      host: (graphId: string, nodeId: string) => scriptedHost(graphId, nodeId),
      config: (graphId: string, nodeId: string) => ({ nodeId, graphId, scripted: true }),
    } : {}),
  });
}
