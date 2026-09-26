import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import { clampThinkingLevel, type Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { AgentSessionEvent, ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { reportPromptIntegrity } from './prompt-integrity.ts';
import { agentSkillOwnedRoots, agentSkillsDir, nativeSkillDirs } from './agent-skills.ts';
import { modelRequestHeaders, type ModelApi, type ModelEntry } from '../catalog/models.ts';
import { thinkingLevelMapFor } from '../catalog/thinking.ts';
import { appendNodeEntry, recordNodeSession } from '../core/node-run.ts';
import { digest, recordContextSession } from '../core/context.ts';
import { inspectResultHandoffSubmission, resultHandoffFromSubmission, resultHandoffRecoveryContext } from '../core/predecessor-handoff.ts';
import { RuntimeError, type ActionAdapter, type Json, type NodeSpec, type Proposal } from '../core/types.ts';
import { promptImagesFromAttachments } from '../core/attachments.ts';
import type { TaskStore } from '../core/store.ts';
import type { ArtifactWorkspace } from '../core/artifact-workspace.ts';
import { insertQuestion } from '../core/question-routing.ts';
import { isFullAccess } from '../core/access-policy.ts';
import { openConversationTools, type ConversationToolService } from './conversation-tools.ts';
import { agentTools } from './agent-tools.ts';
import { conversationActivityRecords, persistConversationActivity, conversationForTask, publishConversationDelta, RSI_RELOAD_RECEIPT } from '../core/conversation.ts';
import { unknownUsageIsNonBlocking } from '../core/budget-ledger.ts';
import type { CapabilityPermissionRequest } from './capabilities.ts';
import type { CapabilityOperation } from './capability-bundle.ts';
import { openAgentContextAssembly } from './agent-context-assembly.ts';
import { agentArtifactAccess } from './agent-tool-definitions.ts';
import { graphApplicationRoot } from './graph-root.ts';
import { piNativeToolNamesForPlatform } from './pi-native-tools.ts';
import { recordCapabilityLoad } from '../core/node-run.ts';
import { COMPACTION_INSTRUCTIONS, isCompactionNoop, compactionSettings, latestContextTokens, shouldCompactContext } from './compaction.ts';
import { controlledOpenAIStream, type ControlledStreamUsageOptions, type SendGate } from './controlled-openai.ts';
import { guardHandoffResponses } from './handoff-response.ts';
import type { ModelScheduler } from './model-scheduler.ts';
import { waitForAgentExecutionSlot } from './execution-slots.ts';
import { finishOperationCredentialWait, markOperationCredentialWait } from '../core/operation-lifecycle.ts';
import { generatePromptSuggestion, selectPromptSuggestionModel, type PromptSuggestionReply } from './prompt-suggestion.ts';
import { rsiChangeMaterial } from './rsi.ts';
import {
  createRestrictedProcessAgentSessionTransport,
  type AgentSession,
  type AgentSessionTransport,
} from './agent-session.ts';
import { createRetrievalBroker } from './retrieval.ts';
import { taskGate } from './task-gate.ts';
import { openWorkspaceCommandRunner } from './workspace-command.ts';
import { linkProjectDependencies } from './project-dependencies.ts';
import { mergeUsageSource, usageSourceOf, type TokenUsage } from './call-broker.ts';
import { DEFAULT_PROMPT_SUGGESTION_PROMPT, DEFAULT_SEDIMENT_PROMPT, type AgentContextLibrary } from './agent-context.ts';
import {
  existingSkillSummaries, generateSkillProposal, runSedimentReview, sedimentCandidates, sedimentReplyShape, selectSedimentModel, type SedimentReply, type SedimentSettings,
} from './sediment.ts';

export interface PiAdapterChannels {
  /** The conversation service, as far as tools over other conversations need it. */
  conversations?: { service: ConversationToolService };
  supervisor: (taskId: string) => {
    propose(proposal: Proposal, requestId: string): Promise<unknown>;
    withdrawDraft?(input: { proposalVersion: number; reason?: string; requestId: string }): Promise<unknown>;
    revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; retire?: string[]; requestId: string; taskId?: string }): Promise<unknown>;
    graphState?(): Promise<unknown>;
    taskStatus?(input: { taskId?: string; nodeId?: string; waitForNode?: string; timeoutMs?: number }): Promise<unknown>;
    validateProposal?(proposal: Proposal): Promise<unknown>;
    listProjects?(): Promise<unknown>;
    bindProject?(input: { projectId: string; requestId: string }): Promise<unknown>;
    listProblems(): Promise<unknown>;
    resolveProblem(input: {
      questionId: string;
      action: 'retry' | 'acknowledge' | 'respond' | 'reconcile_usage' | 'escalate';
      response?: string;
      proof?: string;
      requestId: string;
    }): Promise<unknown>;
  };
  catalog: Catalog;
  agentContext?: AgentContextLibrary;
  bootstrapPrompts?: Record<string, string>;
  bootstrapToolPrompt?: string;
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  };
  rsi?: {
    readonly available: boolean;
    status(): Promise<unknown>;
    apply(input: unknown, context: { taskId: string; conversationId?: string; operationId?: string }): Promise<unknown>;
  };
}

/** The SDK model Graph sends with. Exported so the thinking-strength view is
 * computed from the very object the transport uses. */
export function toPiModel(entry: ModelEntry): Model<ModelApi> {
  const headers = modelRequestHeaders(entry);
  const thinkingLevelMap = thinkingLevelMapFor(entry);
  return {
    id: entry.modelId ?? entry.id, name: entry.id, provider: entry.provider, api: entry.api, baseUrl: entry.baseUrl,
    // Every model is treated as thinking-capable: the console no longer asks,
    // and the SDK's own supported-level rule short-circuits to `off` when this
    // flag is false. A legacy `reasoning: false` entry is therefore ignored.
    reasoning: true, input: entry.input ?? ['text'], contextWindow: entry.contextWindow, maxTokens: entry.maxTokens,
    // A model takes only the effort levels its catalog entry names; the SDK maps
    // Pi's level onto the provider's own value at the wire.
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    // Pi's Model.cost is required numeric metadata; Graph billing uses catalog cost, never this placeholder.
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Gateway routing headers (for example x-opencode-session) must travel
    // with every provider request.
    ...(headers ? { headers } : {}),
  };
}

/** One-line summary of a tool call for the conversation activity stream. */
function summarizeToolCall(name: string, args: unknown) {
  const body = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const target = (key: string) => typeof body[key] === 'string' ? body[key] as string : undefined;
  const summary = name === 'read' || name === 'write_file' || name === 'list_dir' ? target('path') ?? name
    : name === 'artifact_publish' ? [target('namespace'), target('name')].filter(Boolean).join('/') || name
      : name === 'artifact_read' || name === 'artifact_retire' ? `${target('artifactId') ?? name}${typeof body.version === 'number' ? `@${body.version}` : ''}`
        : name === 'artifact_list' ? target('namespace') ?? target('prefix') ?? name
    : name === 'run_command' ? [target('command'), ...(Array.isArray(body.args) ? (body.args as unknown[]).map(String) : [])].filter(Boolean).join(' ')
      : name === 'fetch' ? target('url') ?? name
        : name === 'propose_graph' || name === 'confirm_draft' ? 'draft'
          : name === 'validate_proposal' ? 'validation'
            : name === 'get_graph_state' ? 'current graph'
              : name === 'get_task_status' ? 'task status'
              : name === 'bind_project' ? target('projectId') ?? name
                : name.startsWith('git_') ? [name, target('path') ?? target('ref') ?? ''].filter(Boolean).join(' ')
                  : name === 'submit_result' ? 'structured result'
                    : name === 'apply_rsi_change' ? target('title') ?? 'self-improvement'
                      : name === 'inspect_rsi_status' ? 'self-improvement status'
                    : name;
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

// One Pi operation is a whole session of provider calls, not a single request.
// This bound covers a long planning or coding session while still stopping a
// runaway loop for user acknowledgement inside the 20M instance budget.
const PI_SESSION_RESERVE = 2_000_000;
const CONVERSATION_DELTA_FLUSH_MS = 60;
const PROMPT_SUGGESTION_TIMEOUT_MS = 5_000;

function combineKnownUsage(base: TokenUsage | null, extra: TokenUsage | null) {
  if (!base || !extra) return base;
  return {
    input: base.input + extra.input,
    output: base.output + extra.output,
    cacheRead: base.cacheRead + extra.cacheRead,
    cacheWrite: base.cacheWrite + extra.cacheWrite,
    usageSource: mergeUsageSource(usageSourceOf(base), usageSourceOf(extra)),
  };
}

/** Production Agent adapter: one Task Runtime operation opens a restored Pi instance and sends one prompt. */
export function createPiAdapter(options: {
  store: TaskStore;
  instancesDir: string;
  catalog: Catalog;
  artifacts?: ArtifactWorkspace;
  directory: () => ModelEntry[];
  /** Fallback key for entries without a per-model credential binding. */
  apiKey?: string;
  /** Resolve the key per model so aliases on different credentials never share one. */
  apiKeyFor?: (entry: ModelEntry) => string | undefined;
  /** Full credential binding for one model, including concurrency caps. */
  bindingFor?: (entry: ModelEntry) => { apiKey: string; credentialId: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
  scheduler?: ModelScheduler;
  /** Settings for the post-operation skill review, read live so the switch needs no restart. */
  sediment?: () => SedimentSettings;
  modelRuntime: ModelRuntime;
  network?: { retrievalDomains?: string[]; mcpDomains?: string[] };
  capabilitySecrets?: () => Record<string, string>;
  /** Optional provider adapter for subscription/account-level usage deltas. */
  accountUsageDelta?: ControlledStreamUsageOptions['accountUsageDelta'];
  channels?: PiAdapterChannels;
  transport?: AgentSessionTransport;
}): ActionAdapter {
  const transport = options.transport ?? createRestrictedProcessAgentSessionTransport();
  const activeInstances = new Map<string, AgentSession>();
  /** The live turn's ordinal allocator, so a steering message can take its place
   * in the order of the turn it interrupts. */
  const turnOrdinals = new Map<string, () => number>();
  const systemChangeApplications = new Map<string, Promise<Record<string, unknown>>>();
  return {
    kind: 'agent',
    reserveTokens: PI_SESSION_RESERVE,
    canReplayBeforeSend: operation => {
      // Capability load is recorded before transport.open can start the Pi
      // session (including extension hooks). A model send is also recorded
      // before it reaches the provider. Only replay before both boundaries.
      return !options.store.db.prepare('SELECT 1 FROM node_capabilities WHERE operation_id=? LIMIT 1').get(operation.id)
        && !options.store.db.prepare('SELECT 1 FROM invocations WHERE operation_id=? LIMIT 1').get(operation.id);
    },
    async steer(operation, text) {
      const active = activeInstances.get(operation.id);
      if (!active) throw new RuntimeError('no_active_operation', 'The master Agent is no longer accepting steering messages');
      await active.steer(text);
      // The injected message takes the next ordinal of the turn it interrupted, so
      // the transcript can show it where it landed instead of above the turn.
      const ordinal = turnOrdinals.get(operation.id)?.();
      return ordinal === undefined ? {} : { ordinal };
    },
    /** Soft-stop the turn an operation is running: the in-flight tool call
     * finishes, the turn ends before the next model request, and the session is
     * retained. Idempotent when the operation has no live session. */
    async stop(operation) {
      const active = activeInstances.get(operation.id);
      if (!active) return;
      await active.stop();
    },
    prepare: async operation => {
      if (!operation.instanceId) throw new RuntimeError('invalid_adapter', 'Agents require an instance');
      const instance = options.store.db.prepare('SELECT definition_version,model FROM instances WHERE id=?').get(operation.instanceId) as { definition_version: string | null; model: string | null };
      const entry = options.directory().find(model => model.id === instance.model);
      if (!entry) throw new RuntimeError('model_unavailable', 'No configured model for this instance');
      const modelNow = (candidate: ModelEntry) => options.directory().find(model => model.id === candidate.id) ?? candidate;
      const endpointChanged = (candidate: ModelEntry, latest: ModelEntry) => latest.baseUrl !== candidate.baseUrl || latest.api !== candidate.api
        || JSON.stringify(latest.headers ?? {}) !== JSON.stringify(candidate.headers ?? {});
      const resolveBindingFor = (candidate: ModelEntry) => options.bindingFor?.(candidate)
        ?? (options.apiKeyFor?.(candidate) || options.apiKey ? { credentialId: candidate.credentialId ?? candidate.id, apiKey: (options.apiKeyFor?.(candidate) ?? options.apiKey)! } : undefined);
      const bindingLimits = (value: { limit?: number; sharedGroupId?: string; groupLimit?: number }) => ({
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
        ...(value.sharedGroupId ? { sharedGroupId: value.sharedGroupId } : {}),
        ...(value.groupLimit !== undefined ? { groupLimit: value.groupLimit } : {}),
      });
      const resolveKeyFor = (candidate: ModelEntry) => {
        const latest = modelNow(candidate);
        if (endpointChanged(candidate, latest)) throw new RuntimeError('model_changed', `Model ${candidate.id} endpoint or protocol changed while this request waited; it will be re-prepared`);
        const current = resolveBindingFor(candidate);
        if (!current) throw new RuntimeError('model_unavailable', `No credential bound for model ${candidate.id}`);
        return current.apiKey;
      };
      const resolveBinding = () => resolveBindingFor(entry);
      if (!resolveBinding()) throw new RuntimeError('model_unavailable', `No credential bound for model ${entry.id}`);
      const scheduler = options.scheduler;
      // waiting_slot is what keeps a parked operation out of execution
      // accounting; a failed write must fail the operation, not be hidden.
      const setWaitingSlot = (waiting: boolean) => {
        const now = Date.now();
        if (waiting) {
          markOperationCredentialWait(options.store, operation.id, now);
        } else {
          finishOperationCredentialWait(options.store, operation.id, now);
        }
      };
      const slotFor = (candidate: ModelEntry) => {
        const binding = resolveBindingFor(candidate);
        if (!binding) throw new RuntimeError('model_unavailable', `No credential bound for model ${candidate.id}`);
        return scheduler && (binding.limit !== undefined || binding.groupLimit !== undefined)
          ? {
            acquire: async (signal?: AbortSignal) => {
              // Waiting on a credential releases the execution slot; after the
              // credential slot is granted the operation must take an execution
              // slot back before it may send, or many waiters resuming at once
              // would exceed the global Agent limit.
              setWaitingSlot(true);
              let releaseCredential: (() => void) | undefined;
              try {
                // The queued binding can change under a hot config apply. The
                // waiter asks for the live key/limits on every grant decision;
                // when the identity changed after the grant, the old slot is
                // returned and the request re-queues under the new identity
                // instead of sending with a stale or wrong-platform key.
                for (;;) {
                  if (endpointChanged(candidate, modelNow(candidate))) throw new RuntimeError('model_changed', `Model ${candidate.id} endpoint or protocol changed while this request waited; it will be re-prepared`);
                  const current = resolveBindingFor(candidate);
                  if (!current) throw new RuntimeError('model_unavailable', `No credential bound for model ${candidate.id}`);
                  const request = { credentialId: current.credentialId, apiKey: current.apiKey, ...bindingLimits(current) };
                  releaseCredential = await scheduler.acquire({
                    ...request,
                    refresh: () => {
                      const live = resolveBindingFor(candidate);
                      return live ? { credentialId: live.credentialId, apiKey: live.apiKey, ...bindingLimits(live) } : request;
                    },
                  }, signal);
                  const after = resolveBindingFor(candidate);
                  if (after && after.credentialId === current.credentialId && after.apiKey === current.apiKey) break;
                  releaseCredential();
                  releaseCredential = undefined;
                }
                await waitForAgentExecutionSlot(options.store, operation.id, signal);
                return releaseCredential;
              } catch (error) {
                releaseCredential?.();
                setWaitingSlot(false);
                throw error;
              }
            },
          }
          : undefined;
      };
      const resolveKey = () => resolveKeyFor(entry);
      const slot = slotFor(entry);
      const task = options.store.task(operation.taskId);
      const project = options.store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string };
      const definitionVersion = instance.definition_version ?? 'unknown@1';
      const accessPolicy = operation.accessPolicy;
      const fullAccess = isFullAccess(accessPolicy);
      return async () => {
        const gate = taskGate(
          options.store,
          { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId },
          entry,
          { unrestricted: fullAccess },
        );
        // A pre-send gate refusal (pause, budget, unknown usage) surfaces as an
        // error inside the Pi session; keep it so the operation is not recorded
        // as a success with zero provider requests.
        let gateRefusal: unknown;
        const observedGate: SendGate = {
          dispatch: (id, reservation, send) => {
            let sending = false;
            try {
              return gate.dispatch(id, reservation, () => { sending = true; return send(); });
            } catch (error) {
              if (!sending) gateRefusal = error;
              throw error;
            }
          },
          settle: (id, usage) => gate.settle(id, usage),
        };
        const spec = JSON.parse((options.store.db.prepare('SELECT spec FROM nodes WHERE task_id=? AND id=?').get(operation.taskId, operation.nodeId) as { spec: string }).spec) as NodeSpec;
        const conversation = task.phase === 'chatting' ? conversationForTask(options.store, operation.taskId) : undefined;
        const workspace = await realpath(operation.workspace ?? project.root);
        let submitted: Json | undefined;
        let permissionRequest: CapabilityPermissionRequest | undefined;
        // The agent's own question to the user, asked through ask_user; it turns the turn
        // into a waiting turn once the loop stops.
        let askedQuestion: { prompt: string; why: string } | undefined;
        let reloadReceipt: Record<string, unknown> | undefined;
        const channels = options.channels;
        const agentPromptLibrary = channels?.agentContext;
        let capabilityOperation: CapabilityOperation;
        let contextAssembly: Awaited<ReturnType<typeof openAgentContextAssembly>>;
        let commands: Awaited<ReturnType<typeof openWorkspaceCommandRunner>> | undefined;
        const systemDomains = spec.role === 'master'
          ? ['github.com', 'raw.githubusercontent.com', 'api.github.com']
          : [];
        const retrievalDomains = [...new Set([...(options.network?.retrievalDomains ?? []), ...systemDomains])];
        const unrestrictedRetrieval = accessPolicy?.network === 'unrestricted';
        const retrieval = retrievalDomains.length || unrestrictedRetrieval
          ? createRetrievalBroker({ domains: retrievalDomains, gate, ...(unrestrictedRetrieval ? { unrestricted: true } : {}) })
          : undefined;
        const artifactService = options.artifacts ? {
          ...agentArtifactAccess(spec),
          list: (query: Parameters<ArtifactWorkspace['list']>[0]) => options.artifacts!.list({ ...query, taskId: operation.taskId }),
          get: (artifactId: string, version?: number) => options.artifacts!.get(operation.taskId, artifactId, version),
          read: (artifactId: string, version: number, maxBytes?: number) => options.artifacts!.read(operation.taskId, artifactId, version, maxBytes),
          publish: (input: Parameters<ArtifactWorkspace['publish']>[0]) => options.artifacts!.publish({
            ...input,
            taskId: operation.taskId,
            workspace,
            producer: {
              nodeId: operation.nodeId,
              instanceId: operation.instanceId!,
              operationId: operation.id,
              activationId: operation.activationId,
            },
          }),
          retire: (artifactId: string, version: number, reason: string, requestId: string) => options.artifacts!.retire(operation.taskId, artifactId, version, reason, requestId),
          promote: (input: Parameters<ArtifactWorkspace['promote']>[0]) => options.artifacts!.promote({
            ...input,
            taskId: operation.taskId,
            promotedBy: instance.definition_version ?? operation.nodeId,
          }),
        } : undefined;
        try {
          const definitionId = instance.definition_version?.split('@')[0];
          const skillCapabilityRoot = options.catalog.capabilityRootPath();
          contextAssembly = await openAgentContextAssembly({
            catalog: options.catalog,
            ...(instance.definition_version ? { definitionVersion: instance.definition_version } : {}),
            action: spec.action,
            ...(spec.role ? { role: spec.role } : {}),
            workspace,
            skillProjectRoot: project.root,
            fullAccess,
            retrieval: Boolean(retrieval),
            rsi: Boolean(channels?.rsi?.available && spec.role === 'master' && fullAccess),
            ...(agentPromptLibrary ? { library: agentPromptLibrary } : {}),
            bootstrap: {
              ...(definitionId && channels?.bootstrapPrompts?.[definitionId]
                ? { agent: channels.bootstrapPrompts[definitionId]! } : {}),
              ...(channels?.bootstrapToolPrompt !== undefined ? { tool: channels.bootstrapToolPrompt } : {}),
            },
            ...(options.network?.mcpDomains?.length ? { mcpDomains: options.network.mcpDomains } : {}),
            ...(options.capabilitySecrets ? { secrets: options.capabilitySecrets } : {}),
            ...(definitionId && skillCapabilityRoot ? {
              skillFolder: agentSkillsDir(definitionId, resolve(skillCapabilityRoot, '..')),
              skillOwnedRoots: agentSkillOwnedRoots({
                capabilityRoot: skillCapabilityRoot,
                stateDir: dirname(options.instancesDir),
              }),
            } : {}),
          });
          const bundle = contextAssembly.bundle;
          const capabilityRoot = spec.role === 'master' && options.catalog?.capabilityRootPath()
            ? await realpath(options.catalog.capabilityRootPath()!).catch(() => undefined)
            : undefined;
          const graphRoot = spec.role === 'master'
            ? await realpath(graphApplicationRoot()).catch(() => undefined)
            : undefined;
          const masterReadRoots = spec.role === 'master'
            ? [...new Set([capabilityRoot, graphRoot, agentPromptLibrary?.contextRoot].filter((path): path is string => Boolean(path)))]
            : [];
          // The work copy is dependency-free on disk; the project's own install
          // is linked in and granted to the sandbox so a worker command resolves
          // the project toolchain the way it would in the project root.
          const dependencies = await linkProjectDependencies(workspace, join(project.root, 'node_modules'));
          commands = await openWorkspaceCommandRunner({
            workspace,
            scratchDir: join(options.instancesDir, operation.instanceId!, 'command-scratch'),
            gate,
            ...(accessPolicy ? { access: accessPolicy } : {}),
            ...(dependencies ? { readPaths: [dependencies] } : {}),
          });
          capabilityOperation = await bundle.openOperation({
            workspace,
            scratchDir: join(options.instancesDir, operation.instanceId!, 'capability-scratch'),
            gate,
            action: spec.action,
            ...(spec.role ? { role: spec.role } : {}),
            nativeTools: piNativeToolNamesForPlatform(),
            ...(accessPolicy ? { access: accessPolicy } : {}),
            ...(masterReadRoots.length ? { additionalReadRoots: masterReadRoots } : {}),
            grants: operation.grants,
            disabledTools: contextAssembly.disabledTools,
            onPermissionRequired: request => { permissionRequest ??= request; },
            hostTools: ({ readRoots }) => agentTools({
              workspace, ...(spec.role ? { role: spec.role } : {}),
              // The tool surface records the agent's own question here; the capability
              // layer above knows nothing about it.
              onAskUser: request => { askedQuestion ??= request; },
              ...(accessPolicy ? { access: accessPolicy } : {}),
              ...(readRoots.length ? { readRoots: [...readRoots] } : {}),
              run: (command, args) => commands!.run(command, args),
              ...(retrieval ? { fetch: (url: string) => retrieval.fetch(url) } : {}),
              ...(artifactService ? { artifacts: artifactService } : {}),
              // A master session may hand work to any other conversation. The rules and the handoff
              // ledger live in `conversation-tools.ts`.
              ...(channels?.conversations && conversation && spec.role === 'master' ? {
                conversations: openConversationTools({
                  service: channels.conversations.service,
                  caller: { conversationId: conversation.id, taskId: operation.taskId, nodeId: operation.nodeId },
                  hostWrite: Boolean(accessPolicy && isFullAccess(accessPolicy)),
                  onHandoff: record => options.store.event(operation.taskId, 'conversation.handed_off', record),
                }),
              } : {}),
              ...(channels ? { supervisor: channels.supervisor(operation.taskId), catalog: channels.catalog } : {}),
              ...(channels?.systemContext || channels?.rsi ? {
                systemContext: {
                  ...(channels.systemContext?.systemSummary ? { systemSummary: channels.systemContext.systemSummary } : {}),
                  ...(conversation && spec.role === 'master' ? {
                    systemDiagnostics: async () => {
                      const taskIds = [...new Set([
                        conversation.anchor_task_id,
                        ...(options.store.db.prepare('SELECT id FROM tasks WHERE conversation_id=?').all(conversation.id) as { id: string }[]).map(row => row.id),
                      ])];
                      const placeholders = taskIds.map(() => '?').join(',');
                      const questions = options.store.db.prepare(`SELECT id,task_id AS taskId,node_id AS nodeId,kind,owner,status,data,
                        (SELECT timestamp FROM events
                          WHERE type='question.opened'
                            AND json_extract(data,'$.questionId')=questions.id
                          ORDER BY cursor DESC LIMIT 1) AS created_at
                        FROM questions WHERE status='open' AND task_id IN (${placeholders})
                        ORDER BY rowid DESC LIMIT 100`).all(...taskIds) as {
                          id: string; taskId: string; nodeId: string; kind: string; owner: string; status: string; data: string; created_at: number | null;
                        }[];
                      const failedNodes = options.store.db.prepare(`SELECT n.task_id AS taskId,n.id AS nodeId,n.status,t.request
                        FROM nodes n JOIN tasks t ON t.id=n.task_id
                        WHERE n.status IN ('failed','blocked') AND n.task_id IN (${placeholders})
                        ORDER BY n.rowid DESC LIMIT 50`).all(...taskIds) as {
                          taskId: string; nodeId: string; status: string; request: string;
                        }[];
                      const unknownUsage = options.store.db.prepare(`SELECT task_id AS taskId,node_id AS nodeId,operation_id AS operationId,
                        (SELECT timestamp FROM events
                          WHERE type='question.opened'
                            AND json_extract(data,'$.questionId')=questions.id
                          ORDER BY cursor DESC LIMIT 1) AS createdAt
                        FROM questions WHERE kind='unknown_usage' AND status='open' AND task_id IN (${placeholders})
                        ORDER BY rowid DESC LIMIT 50`).all(...taskIds);
                      const capabilities = options.catalog?.capabilities() ?? [];
                      const artifactStats = options.store.db.prepare(`SELECT
                        COUNT(*) AS versions,
                        COUNT(DISTINCT artifact_id) AS artifacts,
                        COALESCE(SUM(size),0) AS bytes
                        FROM artifacts WHERE task_id IN (${placeholders})`).get(...taskIds) as { versions: number; artifacts: number; bytes: number };
                      return {
                        scope: {
                          conversationId: conversation.id,
                          taskIds,
                        },
                        artifactWorkspace: {
                          scope: 'task',
                          artifacts: Number(artifactStats.artifacts),
                          versions: Number(artifactStats.versions),
                          bytes: Number(artifactStats.bytes),
                          published: (options.store.db.prepare(`SELECT COUNT(*) AS count FROM artifacts WHERE state='published' AND task_id IN (${placeholders})`).get(...taskIds) as { count: number }).count,
                        },
                        pendingSystemChanges: questions.filter(question => question.kind === 'system_change').map(question => {
                          const data = JSON.parse(question.data) as Record<string, Json>;
                          const change = data.change && typeof data.change === 'object' && !Array.isArray(data.change)
                            ? data.change as Record<string, Json>
                            : {};
                          return {
                            questionId: question.id,
                            taskId: question.taskId,
                            nodeId: question.nodeId,
                            proposalId: typeof data.proposalId === 'string' ? data.proposalId : null,
                            title: typeof data.title === 'string' ? data.title : '未命名系统变更',
                            problem: typeof data.problem === 'string' ? data.problem.slice(0, 1_000) : '',
                            changeKind: typeof change.kind === 'string' ? change.kind : null,
                          };
                        }),
                        openInternalProblems: questions.filter(question => question.owner === 'main').map(question => ({
                          questionId: question.id,
                          taskId: question.taskId,
                          nodeId: question.nodeId,
                          kind: question.kind,
                          data: JSON.parse(question.data) as Json,
                          createdAt: question.created_at,
                        })),
                        failedNodes,
                        unknownUsage,
                        capabilityHealth: {
                          total: capabilities.length,
                          invalid: capabilities.filter(capability => capability.status === 'invalid').map(capability => ({
                            id: capability.id,
                            version: capability.version,
                            error: capability.error ?? 'invalid',
                          })).slice(0, 100),
                        },
                      };
                    },
                    proposeSystemChange: async change => {
                      const proposalId = randomUUID();
                      const autoApproved = operation.accessPolicy?.autoApprove.systemChange === true;
                      const question = insertQuestion(options.store, {
                        taskId: operation.taskId,
                        nodeId: operation.nodeId,
                        // A system proposal outlives the model turn that created it.
                        // If it were tied to the operation, settle() would auto-resolve
                        // the question before the user ever sees it.
                        operationId: null,
                        kind: 'system_change',
                        data: {
                          proposalId,
                          title: change.title,
                          problem: change.problem,
                          change: change.change,
                          ...(change.impact ? { impact: change.impact } : {}),
                          ...(change.risk ? { risk: change.risk } : {}),
                          prompt: `系统优化待批准：${change.title}`,
                        },
                        ...(autoApproved && operation.accessPolicy ? {
                          autoAnswer: {
                            answer: {
                              type: 'respond',
                              value: { decision: 'approved', proposalId },
                            },
                            policyDigest: operation.accessPolicy.digest,
                          },
                        } : {}),
                      });
                      return {
                        proposalId,
                        questionId: question.id,
                        status: autoApproved ? 'auto_approved' : 'awaiting_user_approval',
                        instruction: autoApproved
                          ? 'Full access policy approved this proposal. Call apply_system_change now with this proposalId, then report the verified result.'
                          : 'Stop after reporting the proposal. The user must approve it before apply_system_change can run.',
                      };
                    },
                    applySystemChange: proposalId => {
                      const active = systemChangeApplications.get(proposalId);
                      if (active) return active;
                      const apply = async () => {
                        const existing = options.store.db.prepare(`SELECT data FROM events
                          WHERE type='system.change_applied' AND json_extract(data,'$.proposalId')=? ORDER BY cursor DESC LIMIT 1`).get(proposalId) as { data: string } | undefined;
                        if (existing) return JSON.parse(existing.data) as Record<string, unknown>;
                        const row = options.store.db.prepare(`SELECT id,task_id AS taskId,node_id AS nodeId,status,data,answer FROM questions
                          WHERE kind='system_change' AND json_extract(data,'$.proposalId')=? ORDER BY rowid DESC LIMIT 1`).get(proposalId) as {
                            id: string; taskId: string; nodeId: string; status: string; data: string; answer: string | null;
                          } | undefined;
                        if (!row) throw new RuntimeError('not_found', `Unknown system-change proposal ${proposalId}`);
                        if (row.taskId !== operation.taskId || row.nodeId !== operation.nodeId) {
                          throw new RuntimeError('approval_required', 'The system-change proposal belongs to a different Main Agent instance');
                        }
                        if (row.status !== 'resolved' || !row.answer) throw new RuntimeError('approval_required', 'The system change has not been approved by the user');
                        const answer = JSON.parse(row.answer) as { type?: string; value?: { decision?: string } };
                        if (answer.type !== 'respond' || answer.value?.decision !== 'approved') {
                          throw new RuntimeError('approval_required', 'The user did not approve this system change');
                        }
                        const data = JSON.parse(row.data) as { change?: Json };
                        const change = data.change && typeof data.change === 'object' && !Array.isArray(data.change)
                          ? data.change as Record<string, Json>
                          : null;
                        if (!change || change.kind !== 'capability') {
                          throw new RuntimeError('unsupported', 'Only approved capability changes can be applied in this runtime');
                        }
                        const capability = change.capability;
                        if (!capability || typeof capability !== 'object' || Array.isArray(capability)) {
                          throw new RuntimeError('invalid_input', 'The approved capability change is missing its capability bundle');
                        }
                        if (!options.catalog) throw new RuntimeError('unsupported', 'This runtime has no writable capability catalog');
                        const applied = await options.catalog.upsertCapabilityBundle(capability as {
                          manifest: Json;
                          files?: Record<string, string>;
                          overwrite?: boolean;
                        });
                        const receipt = { proposalId, questionId: row.id, applied: true as const, result: applied };
                        options.store.event(operation.taskId, 'system.change_applied', receipt as unknown as Json);
                        return receipt;
                      };
                      const pending = apply().finally(() => {
                        if (systemChangeApplications.get(proposalId) === pending) systemChangeApplications.delete(proposalId);
                      });
                      systemChangeApplications.set(proposalId, pending);
                      return pending;
                    },
                  } : {}),
                  ...(channels.rsi && spec.role === 'master' && fullAccess ? {
                    rsiStatus: async () => (await channels.rsi!.status()) as Record<string, unknown>,
                  } : {}),
                  ...(channels.rsi?.available && spec.role === 'master' && fullAccess ? {
                    rsiApply: async (input: unknown) => {
                      const receipt = await channels.rsi!.apply(input, {
                        operationId: operation.id,
                        taskId: operation.taskId,
                        ...(conversation ? { conversationId: conversation.id } : {}),
                      }) as Record<string, unknown>;
                      if (receipt.status === 'applied' && receipt.restartRequired === true) reloadReceipt = receipt;
                      return receipt;
                    },
                  } : {}),
                },
              } : {}),
              onSubmit: output => { submitted = output; },
              ...(operation.context.outputSchema?.kind === 'result_handoff' ? {
                validateSubmission: (output: Json) => {
                  const inspection = inspectResultHandoffSubmission(
                    output,
                    resultHandoffRecoveryContext(options.store, { taskId: operation.taskId, workspace }),
                  );
                  return inspection.draft ? { ok: true as const } : { ok: false as const, defects: inspection.defects };
                },
              } : {}),
            }),
          });
        } catch (error) {
          // A missing or unsupported bound capability stops this node with a concrete
          // reason instead of silently running without the definition's capabilities.
          await commands?.close().catch(() => undefined);
          return { outcome: 'failed', output: { setupError: String(error) }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        }
        const tools = [...capabilityOperation.tools];
        // A stored level can predate a catalog refresh, or name a model the
        // snapshot does not list: clamp it to a level this model accepts before
        // the turn runs, using the same SDK rule the console displays.
        const thinkingLevel = clampThinkingLevel(toPiModel(entry), (conversation?.thinking_level ?? 'off') as ThinkingLevel) as ThinkingLevel;
        const modelPolicyDigest = digest({
          id: entry.id,
          modelId: entry.modelId ?? null,
          provider: entry.provider,
          api: entry.api,
          baseUrl: entry.baseUrl,
          contextWindow: entry.contextWindow,
          maxTokens: entry.maxTokens,
          thinkingLevel,
        });
        const toolPolicyDigest = capabilityOperation.toolPolicyDigest;
        const definitionVersion = instance.definition_version ?? 'unknown@1';
        const composedPrompt = contextAssembly.forOperation(capabilityOperation).composed;
        const agentContext = operation.context.agentContext;
        if (agentContext?.mode === 'fork') {
          if (!agentContext.sourceSessionFile) throw new RuntimeError('context_rejected', 'Fork context is missing its source session file');
          const sourceBinding = options.store.db.prepare(`SELECT capability_digest,model_policy_digest,tool_policy_digest
            FROM agent_context_bindings WHERE instance_id=?`).get(agentContext.sourceInstanceId!) as {
              capability_digest: string | null;
              model_policy_digest: string | null;
              tool_policy_digest: string | null;
            } | undefined;
          if (!agentContext.rebrand) {
            if (!sourceBinding?.capability_digest || !sourceBinding.model_policy_digest || !sourceBinding.tool_policy_digest) {
              throw new RuntimeError('context_rejected', 'Fork source has no complete policy digest; set context.rebrand=true to allow it');
            }
            if (sourceBinding.capability_digest !== capabilityOperation.bundleDigest) {
              throw new RuntimeError('context_rejected', 'Fork context changes the capability bundle; set context.rebrand=true to allow it');
            }
            if (sourceBinding.model_policy_digest !== modelPolicyDigest) {
              throw new RuntimeError('context_rejected', 'Fork context changes the model policy; set context.rebrand=true to allow it');
            }
            if (sourceBinding.tool_policy_digest !== toolPolicyDigest) {
              throw new RuntimeError('context_rejected', 'Fork context changes the tool policy; set context.rebrand=true to allow it');
            }
          }
        }
        // Record what was actually loaded for this operation so the node
        // projection cannot later guess from catalog status.
        recordCapabilityLoad(options.store, {
          taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
          operationId: operation.id, readOnly: false, report: capabilityOperation.report,
          digest: capabilityOperation.bundleDigest,
          toolPolicyDigest: capabilityOperation.toolPolicyDigest,
          runtimePolicyDigest: capabilityOperation.runtimePolicyDigest,
        });
        // Live conversation text and tool activity are separate from the final
        // message: deltas are coalesced for reconnect, the durable record is
        // written by the kernel when the operation settles. One live part is one
        // text part of one assistant message, so text emitted before and after a
        // tool call stays apart and keeps its place in the turn; `ordinal` is the
        // shared order of text parts and tool calls.
        const parts = new Map<string, { entryId: string; partId: string; text: string; buffer: string; lastFlush: number; ordinal: number }>();
        let entrySeq = 0;
        let currentEntryId = '';
        let ordinal = 0;
        const nextOrdinal = () => { ordinal += 1; return ordinal; };
        turnOrdinals.set(operation.id, nextOrdinal);
        const flushPart = (part: { entryId: string; partId: string; text: string; buffer: string; lastFlush: number; ordinal: number }, force: boolean) => {
          if (!conversation || !part.buffer) return;
          const now = Date.now();
          if (!force && now - part.lastFlush < CONVERSATION_DELTA_FLUSH_MS) return;
          const text = part.buffer;
          part.buffer = '';
          part.lastFlush = now;
          publishConversationDelta(options.store, {
            taskId: operation.taskId,
            conversationId: conversation.id,
            operationId: operation.id,
            entryId: part.entryId,
            partId: part.partId,
            ordinal: part.ordinal,
            delta: text,
            text: part.text,
            length: part.text.length,
          });
        };
        const flushDeltas = (force: boolean) => { for (const part of parts.values()) flushPart(part, force); };
        const toolSummaries = new Map<string, string>();
        const activeConversationTools = new Set<string>();
        const toolActivity: { toolCallId: string; name: string; summary: string; state: 'done' | 'error' }[] = [];
        // Ordered turn activity for a conversation transcript: the narration
        // between tool calls and the tool calls themselves, in the order they
        // happened. Narration is complete only at message_end, so its record is
        // created when the first text part starts and filled in later.
        type ActivityRecord =
          | { type: 'narration'; text: string; ordinal: number }
          | { type: 'tool'; toolCallId: string; name: string; summary: string; state: 'done' | 'error'; ordinal: number };
        const activity: ActivityRecord[] = [];
        const narrationByEntry = new Map<string, { type: 'narration'; text: string; ordinal: number }>();
        const toolOrdinals = new Map<string, number>();
        const livePart = (contentIndex: number) => {
          if (!currentEntryId) { entrySeq += 1; currentEntryId = `entry-${entrySeq}`; }
          const partId = String(contentIndex);
          const key = `${currentEntryId}\u0000${partId}`;
          const existing = parts.get(key);
          if (existing) return existing;
          const part = { entryId: currentEntryId, partId, text: '', buffer: '', lastFlush: 0, ordinal: nextOrdinal() };
          parts.set(key, part);
          const narration = { type: 'narration' as const, text: '', ordinal: part.ordinal };
          activity.push(narration);
          narrationByEntry.set(currentEntryId, narration);
          return part;
        };
        const persistEntries = !conversation;
        let sawAssistantMessageEnd = false;
        let compacting = false;
        const onEvent = (event: AgentSessionEvent) => {
          if (event.type === 'message_start') {
            entrySeq += 1;
            currentEntryId = `entry-${entrySeq}`;
            return;
          }
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
            const part = livePart(event.assistantMessageEvent.contentIndex);
            part.text += event.assistantMessageEvent.delta;
            part.buffer += event.assistantMessageEvent.delta;
            flushPart(part, false);
            return;
          }
          if (event.type === 'message_end') {
            // Real assistant message from the Pi session, not a fabricated
            // summary of the final output.
            const message = (event as unknown as { message?: { role?: string; content?: unknown } }).message;
            // Since 0.86 a system or user message carries plain string content
            // (types.d.ts: content: string | TextContent[]), so the role has to be
            // checked before the array shape is assumed.
            const content = message?.content;
            const text = message?.role !== 'assistant' ? ''
              : typeof content === 'string' ? content
              : Array.isArray(content)
                ? (content as { type?: string; text?: string }[]).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!).join('')
                : '';
            if (message?.role === 'assistant' && text.trim()) {
              if (persistEntries) {
                sawAssistantMessageEnd = true;
                appendNodeEntry(options.store, {
                  taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                  activationId: operation.activationId, operationId: operation.id, role: 'assistant', kind: 'message', text,
                });
              } else {
                // The same narration a subagent window shows between its tool
                // calls, kept as one readable record of the turn.
                const narration = narrationByEntry.get(currentEntryId);
                if (narration) narration.text = text;
                else {
                  const record = { type: 'narration' as const, text, ordinal: nextOrdinal() };
                  narrationByEntry.set(currentEntryId, record);
                  activity.push(record);
                }
              }
            }
            if (!persistEntries) {
              flushDeltas(true);
              currentEntryId = '';
            }
            return;
          }
          if (persistEntries && event.type === 'tool_execution_start') {
            appendNodeEntry(options.store, {
              taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
              activationId: operation.activationId, operationId: operation.id, role: 'tool', kind: 'call',
              text: summarizeToolCall(event.toolName, event.args), data: { toolCallId: event.toolCallId, toolName: event.toolName },
            });
          }
          if (persistEntries && event.type === 'tool_execution_end') {
            appendNodeEntry(options.store, {
              taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
              activationId: operation.activationId, operationId: operation.id, role: 'tool', kind: 'result',
              text: event.isError ? '工具执行失败' : '工具执行完成', data: { toolCallId: event.toolCallId, toolName: event.toolName, isError: event.isError },
            });
          }
          // Pi context summarization is billed like any other send: tag the
          // invocations it emits while compacting, then record the summary as
          // its own line without touching the conversation/tool entries.
          if (event.type === 'compaction_start') {
            compacting = true;
            gate.setPurpose('compaction');
            options.store.event(operation.taskId, 'session.compaction_started', {
              nodeId: operation.nodeId, operationId: operation.id, reason: event.reason,
            });
            return;
          }
          if (event.type === 'compaction_end') {
            compacting = false;
            gate.setPurpose('completion');
            if (!event.aborted && event.result) {
              const data = {
                reason: event.reason, operationId: operation.id,
                tokensBefore: event.result.tokensBefore,
                completionSequence: (options.store.db.prepare("SELECT COALESCE(MAX(rowid),0) AS sequence FROM invocations WHERE instance_id=? AND purpose='completion'").get(operation.instanceId!) as { sequence: number }).sequence,
                ...(event.result.estimatedTokensAfter !== undefined ? { tokensAfter: event.result.estimatedTokensAfter } : {}),
              };
              if (persistEntries) {
                appendNodeEntry(options.store, {
                  taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                  activationId: operation.activationId, operationId: operation.id, role: 'system', kind: 'compaction',
                  text: event.result.summary, data,
                });
              }
              // A conversation keeps its messages untouched; the compaction is
              // reported as a session event instead of overwriting history.
              options.store.event(operation.taskId, 'session.compacted', { nodeId: operation.nodeId, ...data });
            } else {
              // Pi's own threshold/overflow compaction can fail without throwing
              // (a summarizer that hits its output cap). Record it so the failure
              // is visible instead of silently leaving the context oversized.
              options.store.event(operation.taskId, isCompactionNoop(event.errorMessage ?? '') ? 'session.compaction_skipped' : 'session.compaction_failed', {
                nodeId: operation.nodeId, operationId: operation.id, reason: event.reason,
                error: event.errorMessage ?? 'compaction aborted',
              });
            }
            return;
          }
          if (!conversation) return;
          if (event.type === 'tool_execution_start') {
            const summary = summarizeToolCall(event.toolName, event.args);
            toolSummaries.set(event.toolCallId, summary);
            const callOrdinal = nextOrdinal();
            toolOrdinals.set(event.toolCallId, callOrdinal);
            activity.push({ type: 'tool', toolCallId: event.toolCallId, name: event.toolName, summary, state: 'done', ordinal: callOrdinal });
            flushDeltas(true);
            activeConversationTools.add(event.toolCallId);
            persistConversationActivity(options.store, conversation.id, operation.id, operation.attempt, conversationActivityRecords(activity, ''), activeConversationTools);
            options.store.event(operation.taskId, 'message.tool', { operationId: operation.id, phase: 'start', toolCallId: event.toolCallId, toolName: event.toolName, summary, ordinal: callOrdinal });
          } else if (event.type === 'tool_execution_end') {
            const summary = toolSummaries.get(event.toolCallId) ?? event.toolName;
            toolActivity.push({ toolCallId: event.toolCallId, name: event.toolName, summary, state: event.isError ? 'error' : 'done' });
            const record = activity.find(item => item.type === 'tool' && item.toolCallId === event.toolCallId);
            if (record && record.type === 'tool') record.state = event.isError ? 'error' : 'done';
            activeConversationTools.delete(event.toolCallId);
            persistConversationActivity(options.store, conversation.id, operation.id, operation.attempt, conversationActivityRecords(activity, ''), activeConversationTools);
            options.store.event(operation.taskId, 'message.tool', { operationId: operation.id, phase: 'end', toolCallId: event.toolCallId, toolName: event.toolName, summary, isError: event.isError, ordinal: toolOrdinals.get(event.toolCallId) ?? nextOrdinal() });
          }
        };
        try {
          // Context size comes from the last billed completion for this
          // instance, so Graph can compact before the window is exceeded
          // instead of waiting for a provider overflow. Ignore Pi's zero-usage
          // placeholders, and use a newer successful compaction estimate when
          // the previous turn ended in a manual compaction.
          const lastContextTokens = (() => {
            const completions = options.store.db.prepare(
              `SELECT i.rowid AS sequence, i.usage, COALESCE(o.settled_at, o.dispatched_at, 0) AS settled_at
               FROM invocations i
               JOIN operations o ON o.id = i.operation_id
               WHERE i.instance_id = ? AND i.purpose = 'completion' AND i.usage IS NOT NULL
               ORDER BY i.rowid DESC LIMIT 20`,
            ).all(operation.instanceId!) as { usage: string; settled_at: number; sequence: number }[];
            const lastCompaction = options.store.db.prepare(
              `SELECT e.timestamp, e.data
               FROM events e
               JOIN operations o ON o.id = json_extract(e.data, '$.operationId')
               WHERE e.task_id = ? AND e.type = 'session.compacted' AND o.instance_id = ?
               ORDER BY e.cursor DESC LIMIT 1`,
            ).get(operation.taskId, operation.instanceId!) as { timestamp: number; data: string } | undefined;
            return latestContextTokens(
              completions.map(row => ({ usage: row.usage, settledAt: row.settled_at, sequence: row.sequence })),
              lastCompaction,
            );
          })();
          // The skills the session may read must match the block Graph renders: the bound
          // snapshots plus the SDK's own global and project folders.
          const skillReadPaths = [...new Set([...capabilityOperation.skillPaths, ...nativeSkillDirs({ cwds: [workspace, project.root] })])];
          const session = await transport.open({
            binding: { instanceId: operation.instanceId!, nodeId: operation.nodeId, definitionVersion },
            // Durable telemetry for every tool call this instance executes, Graph's and Pi's alike.
            // The write is guarded here: a statistics table must never be able to break a turn.
            onToolCall: call => {
              try {
                options.store.recordToolCall({
                  instanceId: operation.instanceId!, tool: call.tool, ms: call.ms, isError: call.isError,
                  ...(call.target ? { target: call.target } : {}),
                });
              } catch (error) {
                // Observed, not executed: recording stays outside the turn's own failure path.
                console.error('[probe] recordToolCall threw', error instanceof Error ? error.message : String(error));
              }
            },
            workspace, stateDir: join(options.instancesDir, operation.instanceId!),
            model: toPiModel(entry),
            stream: guardHandoffResponses(controlledOpenAIStream(observedGate, resolveKey, slot, entry.api, {
              estimateMissing: unknownUsageIsNonBlocking(options.store, operation.instanceId),
              ...(options.accountUsageDelta ? { accountUsageDelta: options.accountUsageDelta } : {}),
              onSend: sent => {
                if (sent.systemPrompt !== null) {
                  options.store.recordOperationSystemPrompt(operation.id, sent.systemPrompt, sent.toolDeclarations ?? undefined);
                }
                // The site that records the truth also reports when a part of it is
                // gone: reporting only, a send is never blocked or rewritten.
                void reportPromptIntegrity(join(options.instancesDir, operation.instanceId!), operation.id, sent.systemPrompt)
                  .catch(() => undefined);
              },
            }), {
              enabled: () => Boolean(conversation) && !compacting,
              onRecovery: status => options.store.event(operation.taskId, 'session.handoff_response', {
                operationId: operation.id, nodeId: operation.nodeId, status,
              }),
            }),
            thinkingLevel,
            tools,
            allowedToolNames: [...capabilityOperation.allowedToolNames],
            ...(skillReadPaths.length ? { skillPaths: skillReadPaths } : {}),
            ...(capabilityOperation.skillFolder ? { skillFolder: capabilityOperation.skillFolder } : {}),
            ...(capabilityOperation.readRoots.length ? { readRoots: [...capabilityOperation.readRoots] } : {}),
            ...(capabilityOperation.writeRoots.length ? { writeRoots: [...capabilityOperation.writeRoots] } : {}),
            ...(Object.keys(capabilityOperation.env).length ? { env: { ...capabilityOperation.env } } : {}),
            ...(capabilityOperation.networkDomains.length ? { networkDomains: [...capabilityOperation.networkDomains] } : {}),
            ...(capabilityOperation.allowUnrestrictedNetwork || accessPolicy?.network === 'unrestricted' ? { allowUnrestrictedNetwork: true } : {}),
            ...(capabilityOperation.allowLocalBinding || accessPolicy?.piExtensions.localBinding ? { allowLocalBinding: true } : {}),
            ...(capabilityOperation.unixSockets.length ? { unixSockets: [...capabilityOperation.unixSockets] } : {}),
            ...(accessPolicy?.piExtensions.unixSockets === 'all' ? { allowAllUnixSockets: true } : {}),
            ...(accessPolicy?.piExtensions.appleEvents ? { allowAppleEvents: true } : {}),
            ...(accessPolicy ? {
              filesystemAccess: accessPolicy.filesystem.read === 'host' || accessPolicy.filesystem.write === 'host' ? 'host' : 'bounded',
              protectedPaths: accessPolicy.protectedPaths,
              allowGitMetadataWritesAll: accessPolicy.filesystem.gitMetadata === 'writable',
            } : {}),
            ...(capabilityOperation.piExtensionPaths.length ? { piExtensionPaths: [...capabilityOperation.piExtensionPaths] } : {}),
            ...(capabilityOperation.mcpAdapterServers.length ? { mcpAdapterServers: [...capabilityOperation.mcpAdapterServers] } : {}),
            piExtensionTools: [...capabilityOperation.piExtensionTools],
            systemPrompt: composedPrompt.text,
            bundleDigest: capabilityOperation.bundleDigest,
            legacyCapabilityDigest: capabilityOperation.legacyPromptDigest,
            toolPolicyDigest: capabilityOperation.toolPolicyDigest,
            runtimePolicyDigest: capabilityOperation.runtimePolicyDigest,
            ...(agentContext?.reviewPolicy ? { freshSession: true } : {}),
            ...(agentContext?.mode === 'fork' && agentContext.sourceSessionFile
              ? { forkFrom: { sessionFile: agentContext.sourceSessionFile, ...(agentContext.sourceLeafId ? { leafId: agentContext.sourceLeafId } : {}) } }
              : {}),
            broker: gate,
            nativeTools: [...capabilityOperation.nativeTools],
            ...(conversation ? { allowWorkspaceChange: true } : {}),
            // Auto-compaction stays on for workers, reviewers and the master;
            // thresholds follow the model that will receive the summary.
            compaction: compactionSettings(entry),
            onEvent,
          });
          activeInstances.set(operation.id, session);
          const inspected = session.inspect();
          const extensionErrors = inspected.extensionErrors ?? [];
          if (extensionErrors.length) {
            const detail = extensionErrors
              .map(item => `${item.path}: ${item.error instanceof Error ? item.error.message : String(item.error)}`)
              .join('; ');
            throw new RuntimeError('capability_unavailable', `A bound Pi extension failed to load: ${detail}`);
          }
          if (persistEntries) {
            recordNodeSession(options.store, operation.instanceId!, inspected.sessionId, inspected.sessionFile);
            if (agentContext) {
              recordContextSession(options.store, {
                taskId: operation.taskId,
                nodeId: operation.nodeId,
                operationId: operation.id,
                bindingId: agentContext.bindingId,
                sessionId: inspected.sessionId,
                capabilityDigest: capabilityOperation.bundleDigest,
                modelPolicyDigest,
                toolPolicyDigest,
                ...(inspected.context?.sourceLeafId ? { sourceLeafId: inspected.context.sourceLeafId } : {}),
                ...(inspected.context?.sourceContextDigest ? { sourceContextDigest: inspected.context.sourceContextDigest } : {}),
                ...(inspected.context?.childContextDigest ? { childContextDigest: inspected.context.childContextDigest } : {}),
              });
            }
          }
          try {
            const compactRequested = operation.context.messages?.some(message => message.command === 'compact') ?? false;
            // Graph triggers compaction itself so the bounded instructions below
            // apply. Pi's own threshold/overflow compaction stays enabled as a
            // backstop for a context Graph mis-estimated.
            const autoCompact = !compactRequested && shouldCompactContext(entry, lastContextTokens);
            if (compactRequested || autoCompact) {
              try {
                await session.compact(COMPACTION_INSTRUCTIONS);
                flushDeltas(true);
                if (gateRefusal) throw gateRefusal;
                const text = '上下文已压缩。';
                if (persistEntries) {
                  appendNodeEntry(options.store, {
                    taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                    activationId: operation.activationId, operationId: operation.id, role: 'system', kind: 'compaction',
                    text,
                  });
                }
                if (compactRequested && !operation.context.rsiContinuation) return { outcome: 'completed', output: { text }, usage: gate.total() };
              } catch (error) {
                // A summarizer that hits its output cap must not poison the
                // turn: the `compaction_end` event already recorded why, so
                // keep going (or report it for a manual request) instead of
                // failing the operation as an unknown dispatch.
                const message = error instanceof Error ? error.message : String(error);
                if (compactRequested && !operation.context.rsiContinuation && isCompactionNoop(message)) {
                  return { outcome: 'completed', output: { text: '上下文已是精简状态，无需再次压缩。' }, usage: gate.total() };
                }
                if (compactRequested && !isCompactionNoop(message)) {
                  return { outcome: 'failed', output: { error: `上下文压缩失败：${message}` }, usage: gate.total() };
                }
              }
            }
            const briefing = operation.context.briefing ?? `Continue work for ${operation.nodeId}`;
            if (persistEntries) {
              appendNodeEntry(options.store, {
                taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                activationId: operation.activationId, operationId: operation.id, role: 'user', kind: 'briefing',
                text: briefing.slice(0, 20_000),
              });
            }
            const userImages = promptImagesFromAttachments(
              (operation.context.messages ?? []).flatMap(message => message.attachments ?? []),
            );
            const result = await session.prompt(briefing, userImages.length ? userImages : undefined);
            flushDeltas(true);
            if (gateRefusal) throw gateRefusal;
            // A turn that applied and activated a harness change is the one turn with no assistant reply:
            // the model is never asked again after the apply. It is also the turn that did the most real
            // work, so this no longer returns here — that used to skip the suggestion and the review
            // entirely — and the handoff waits below until both have had their look at the change.
            // A provider or transport error ends the turn with an assistant
            // error message; that is a failure, never a successful operation.
            if (result.stopReason === 'error') {
              return { outcome: 'failed', output: { error: result.errorMessage ?? 'Model request failed' }, usage: gate.total() };
            }
            if (result.stopReason === 'length') {
              return {
                outcome: 'failed',
                output: { error: 'Model response hit the output token limit before completing the reply' },
                usage: gate.total(),
              };
            }
            // An explicit question from the agent ends the turn: the answer is the next
            // turn's input, so waiting costs no further model requests.
            if (askedQuestion) {
              return {
                outcome: 'waiting',
                output: { question: { prompt: askedQuestion.prompt, why: askedQuestion.why } },
                question: {
                  prompt: askedQuestion.prompt,
                  data: { requestType: 'user_decision', prompt: askedQuestion.prompt, why: askedQuestion.why },
                },
                usage: gate.total(),
              };
            }
            if (permissionRequest) {
              return {
                outcome: 'waiting', output: { permission: { grant: permissionRequest.grant, capabilityId: permissionRequest.capabilityId, tool: permissionRequest.tool } },
                question: { prompt: `Remote MCP tool ${permissionRequest.tool} requires the user grant ${permissionRequest.grant} in this task`, grant: permissionRequest.grant },
                usage: gate.total(),
              };
            }
            const text = result.finalAssistantText;
            const reply = text.trim() ? text : [...parts.values()].map(part => part.text).join('');
            flushDeltas(true);
            if (persistEntries && !sawAssistantMessageEnd && reply.trim()) {
              appendNodeEntry(options.store, {
                taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                activationId: operation.activationId, operationId: operation.id, role: 'assistant', kind: 'message', text: reply,
              });
            }
            let suggestedPrompt: string | undefined;
            let suggestionUsage: TokenUsage | null = null;
            let suggestionReply: PromptSuggestionReply | null = null;
            const lastUserMessage = [...(operation.context.messages ?? [])].reverse()
              .find(message => message.text.trim())?.text;
            const suggestionEntry = conversation && lastUserMessage
              ? selectPromptSuggestionModel(entry, options.directory())
              : undefined;
            if (suggestionEntry && reply.trim()) {
              const controller = new AbortController();
              const timeout = setTimeout(() => controller.abort(), PROMPT_SUGGESTION_TIMEOUT_MS);
              timeout.unref?.();
              const suggestionGate = taskGate(
                options.store,
                { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId },
                suggestionEntry,
                { optional: true },
              );
              suggestionGate.setPurpose('prompt_suggestion');
              try {
                suggestionReply = await generatePromptSuggestion({
                  stream: controlledOpenAIStream(suggestionGate, resolveKeyFor(suggestionEntry), slotFor(suggestionEntry), suggestionEntry.api, {
                    estimateMissing: true,
                    ...(options.accountUsageDelta ? { accountUsageDelta: options.accountUsageDelta } : {}),
                  }),
                  model: toPiModel(suggestionEntry),
                  userMessage: lastUserMessage!,
                  assistantReply: reply,
                  systemPrompt: agentPromptLibrary ? await agentPromptLibrary.prompt('runtime/prompt-suggestion.md') : DEFAULT_PROMPT_SUGGESTION_PROMPT,
                  signal: controller.signal,
                });
                suggestedPrompt = suggestionReply.text || undefined;
              } catch {
                suggestedPrompt = undefined;
              } finally {
                clearTimeout(timeout);
                suggestionUsage = suggestionGate.total();
              }
            }
            // A failed call and a model that had nothing to suggest used to collapse into the same
            // silent `undefined`. The decision now travels with the turn, with the call's own words.
            if (conversation) {
              options.store.event(operation.taskId, 'prompt_suggestion.decided', {
                operationId: operation.id,
                nodeId: operation.nodeId,
                model: suggestionEntry?.id ?? null,
                asked: Boolean(suggestionEntry && reply.trim()),
                stopReason: suggestionReply?.stopReason ?? null,
                error: suggestionReply?.error ?? null,
                chars: suggestionReply?.raw.length ?? 0,
                suggestion: suggestionReply?.text ?? '',
                replyHead: suggestionReply?.raw.slice(0, 200) ?? '',
              });
            }
            // Sedimentation runs after the turn like the composer suggestion does: one extra call on
            // a cheaper model, through the same gate, and the write happens in `applySedimentProposal`
            // so it cannot escape the project's skill folder. Never allowed to break the turn.
            if (conversation && options.sediment) {
              const settings = options.sediment();
              const sedimentEntry = settings.enabled ? selectSedimentModel(entry, options.directory(), settings.model) : undefined;
              if (sedimentEntry) {
                // What this operation itself did. Counting rows in `tool_calls` instead would make the
                // review wait for somebody to open the statistics page: worker lanes are folded into
                // that table on demand, so a fresh conversation would never reach the threshold.
                const toolCalls = toolActivity.length;
                const payload = {
                  lastUserMessage: lastUserMessage ?? '',
                  // An activation turn carries no assistant reply; the change it applied is the material,
                  // so the review reads what the turn did instead of an empty string.
                  reply: (reloadReceipt ? rsiChangeMaterial(reloadReceipt, reply) : reply).slice(0, 8_000),
                  existingSkills: existingSkillSummaries(project.root),
                };
                const sedimentSystemPrompt = agentPromptLibrary
                  ? await agentPromptLibrary.prompt('runtime/sediment.md')
                  : DEFAULT_SEDIMENT_PROMPT;
                // A cheap model is exactly the one whose account can be out of quota, so a refusal is not
                // the end of the review: candidates are asked in order and every attempt is kept, so the
                // record can never show a single silent failure as if it were a decision.
                const candidates = sedimentCandidates(entry, options.directory(), settings.model);
                const attempts: { model: string; stopReason: string | null; error: string | null; chars: number }[] = [];
                let answered: string | null = null;
                const capture: { reply: SedimentReply | null } = { reply: null };
                try {
                  const decision = await runSedimentReview({
                    gate: {
                      enabled: true, role: 'master', toolCalls,
                      threshold: settings.afterToolCalls,
                      paused: Boolean(options.store.task(operation.taskId).paused),
                      // This block runs once per settled operation, so a second look is impossible here.
                      alreadyReviewed: false,
                    },
                    settings,
                    projectRoot: project.root,
                    payload,
                    review: async () => {
                      for (const candidate of candidates) {
                        const candidateGate = taskGate(
                          options.store,
                          { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId },
                          candidate,
                          { optional: true },
                        );
                        candidateGate.setPurpose('skill_sediment');
                        const candidateReply = await generateSkillProposal({
                          stream: controlledOpenAIStream(candidateGate, resolveKeyFor(candidate), slotFor(candidate), candidate.api, {
                            estimateMissing: true,
                            ...(options.accountUsageDelta ? { accountUsageDelta: options.accountUsageDelta } : {}),
                          }),
                          model: toPiModel(candidate),
                          systemPrompt: sedimentSystemPrompt,
                          payload,
                        });
                        capture.reply = candidateReply;
                        attempts.push({ model: candidate.id, stopReason: candidateReply.stopReason, error: candidateReply.error, chars: candidateReply.raw.length });
                        // An account that is out of quota can answer with an empty message that still says
                        // "stop": only usable text ends the walk, or the review stops at the refusal.
                        const usable = candidateReply.text?.trim() ?? '';
                        if (usable) {
                          answered = candidate.id;
                          return usable;
                        }
                      }
                      return null;
                    },
                  });
                  // What the review decided travels with the operation, so "it ran and found nothing",
                  // "it proposed and was refused", "it never came back with anything readable" and "every
                  // cheap account refused it" are facts in the store instead of guesses.
                  options.store.event(operation.taskId, 'skill_sediment.reviewed', {
                    operationId: operation.id,
                    nodeId: operation.nodeId,
                    model: answered ?? candidates[0]?.id ?? sedimentEntry.id,
                    toolCalls,
                    threshold: settings.afterToolCalls,
                    reviewed: decision.reviewed,
                    proposed: decision.outcome.proposed,
                    written: decision.outcome.written.map(entry => ({ id: entry.id, replaced: entry.replaced })),
                    refused: decision.outcome.refused,
                    attempts,
                    // What the parser saw, so a lost decision is diagnosable instead of merely invisible.
                    replyShape: capture.reply ? sedimentReplyShape(capture.reply.raw) : null,
                    replyStop: capture.reply?.stopReason ?? null,
                    replyChars: capture.reply?.raw.length ?? 0,
                    replyHead: capture.reply?.raw.slice(0, 200) ?? '',
                    replyError: capture.reply?.error ?? null,
                  });
                } catch {
                  // A review is an observer of the operation, never a step in it.
                }
              }
            }
            // The reload handoff keeps its own output: the console shows the receipt, while the review
            // above already read the change itself.
            if (reloadReceipt) {
              return {
                outcome: 'completed',
                output: { text: RSI_RELOAD_RECEIPT, rsiRequestId: String(reloadReceipt.id), ...(toolActivity.length ? { toolActivity: toolActivity as unknown as Json } : {}), ...(activity.length ? { activity: activity as unknown as Json } : {}) },
                usage: gate.total(),
              };
            }
            // The conversation output always carries the visible reply; worker
            // output keeps its existing submitted-or-text shape.
            const output: Json = conversation
              ? { text: reply, ...(suggestedPrompt ? { suggestedPrompt } : {}), ...(toolActivity.length ? { toolActivity: toolActivity as unknown as Json } : {}), ...(activity.length ? { activity: activity as unknown as Json } : {}), ...(submitted !== undefined ? { submitted } : {}) }
              : (submitted ?? { text });
            const resultHandoff = resultHandoffFromSubmission(submitted);
            return {
              outcome: 'completed',
              output,
              ...(resultHandoff ? { resultHandoff } : {}),
              usage: combineKnownUsage(gate.total(), suggestionUsage),
            };
          } finally {
            activeInstances.delete(operation.id);
            await session.close();
          }
        } finally { await capabilityOperation.close(); await commands.close(); }
      };
    },
  };
}
