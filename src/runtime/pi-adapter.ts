import { join } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { AgentSessionEvent } from '@earendil-works/pi-coding-agent';
import type { Catalog } from '../catalog/catalog.ts';
import { modelRequestHeaders, type ModelApi, type ModelEntry } from '../catalog/models.ts';
import { appendNodeEntry, recordNodeSession } from '../core/node-run.ts';
import { digest, recordContextSession } from '../core/context.ts';
import { RuntimeError, type ActionAdapter, type Json, type NodeSpec, type Proposal } from '../core/types.ts';
import type { TaskStore } from '../core/store.ts';
import { agentTools } from './agent-tools.ts';
import { conversationForTask } from '../core/conversation.ts';
import type { CapabilityPermissionRequest } from './capabilities.ts';
import { openCapabilityBundle, type CapabilityOperation } from './capability-bundle.ts';
import { recordCapabilityLoad } from '../core/node-run.ts';
import { compactionSettings } from './compaction.ts';
import { controlledOpenAIStream, type SendGate } from './controlled-openai.ts';
import type { ModelScheduler } from './model-scheduler.ts';
import { waitForAgentExecutionSlot } from './execution-slots.ts';
import { finishOperationCredentialWait, markOperationCredentialWait } from '../core/operation-lifecycle.ts';
import { openPiProcess } from './pi-process.ts';
import { createRetrievalBroker } from './retrieval.ts';
import { taskGate } from './task-gate.ts';
import { openWorkspaceCommandRunner } from './workspace-command.ts';

export interface PiAdapterChannels {
  supervisor: (taskId: string) => {
    propose(proposal: Proposal, requestId: string): Promise<unknown>;
    revise(input: { baseVersion: number; reason: string; nodes: NodeSpec[]; requestId: string }): Promise<unknown>;
  };
  catalog: Catalog;
  bootstrapPrompts?: Record<string, string>;
  bootstrapToolPrompt?: string;
  systemContext?: {
    systemSummary?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
  };
}

function toPiModel(entry: ModelEntry): Model<ModelApi> {
  const headers = modelRequestHeaders(entry);
  return {
    id: entry.modelId ?? entry.id, name: entry.id, provider: entry.provider, api: entry.api, baseUrl: entry.baseUrl,
    reasoning: entry.reasoning !== false, input: ['text'], contextWindow: entry.contextWindow, maxTokens: entry.maxTokens,
    // Pi's Model.cost is required numeric metadata; Graph billing uses catalog cost, never this placeholder.
    cost: entry.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Gateway routing headers (for example x-opencode-session) must travel
    // with every provider request.
    ...(headers ? { headers } : {}),
  };
}

function assistantText(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: { type: string; text?: string }[] };
    if (message.role === 'assistant') return message.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('') ?? '';
  }
  return '';
}

/** One-line summary of a tool call for the conversation activity stream. */
function summarizeToolCall(name: string, args: unknown) {
  const body = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  const target = (key: string) => typeof body[key] === 'string' ? body[key] as string : undefined;
  const summary = name === 'read' || name === 'write_file' || name === 'list_dir' ? target('path') ?? name
    : name === 'run_command' ? [target('command'), ...(Array.isArray(body.args) ? (body.args as unknown[]).map(String) : [])].filter(Boolean).join(' ')
      : name === 'fetch' ? target('url') ?? name
        : name === 'propose_graph' ? 'draft'
          : name === 'submit_result' ? 'structured result'
            : name;
  return summary.length > 160 ? `${summary.slice(0, 157)}...` : summary;
}

// One Pi operation is a whole session of provider calls, not a single request.
// This bound covers a long planning or coding session while still stopping a
// runaway loop for user acknowledgement inside the 20M instance budget.
const PI_SESSION_RESERVE = 2_000_000;

/** Production Agent adapter: one Task Runtime operation opens a restored Pi instance and sends one prompt. */
export function createPiAdapter(options: {
  store: TaskStore;
  instancesDir: string;
  catalog: Catalog;
  directory: () => ModelEntry[];
  /** Fallback key for entries without a per-model credential binding. */
  apiKey?: string;
  /** Resolve the key per model so aliases on different credentials never share one. */
  apiKeyFor?: (entry: ModelEntry) => string | undefined;
  /** Full credential binding for one model, including concurrency caps. */
  bindingFor?: (entry: ModelEntry) => { apiKey: string; credentialId: string; limit?: number; sharedGroupId?: string; groupLimit?: number } | undefined;
  scheduler?: ModelScheduler;
  modelRuntime: ModelRuntime;
  network?: { retrievalDomains?: string[]; mcpDomains?: string[] };
  channels?: PiAdapterChannels;
}): ActionAdapter {
  const activeInstances = new Map<string, Awaited<ReturnType<typeof openPiProcess>>>();
  return {
    kind: 'agent',
    reserveTokens: PI_SESSION_RESERVE,
    async steer(operation, text) {
      const active = activeInstances.get(operation.id);
      if (!active) throw new RuntimeError('no_active_operation', 'The master Agent is no longer accepting steering messages');
      await active.steer(text);
    },
    prepare: async operation => {
      if (!operation.instanceId) throw new RuntimeError('invalid_adapter', 'Agents require an instance');
      const instance = options.store.db.prepare('SELECT definition_version,model FROM instances WHERE id=?').get(operation.instanceId) as { definition_version: string | null; model: string | null };
      const entry = options.directory().find(model => model.id === instance.model);
      if (!entry) throw new RuntimeError('model_unavailable', 'No configured model for this instance');
      const entryNow = () => options.directory().find(model => model.id === entry.id) ?? entry;
      const endpointChanged = (latest: ModelEntry) => latest.baseUrl !== entry.baseUrl || latest.api !== entry.api
        || JSON.stringify(latest.headers ?? {}) !== JSON.stringify(entry.headers ?? {});
      const resolveBinding = () => options.bindingFor?.(entry)
        ?? (options.apiKeyFor?.(entry) || options.apiKey ? { credentialId: entry.credentialId ?? entry.id, apiKey: (options.apiKeyFor?.(entry) ?? options.apiKey)! } : undefined);
      const bindingLimits = (value: { limit?: number; sharedGroupId?: string; groupLimit?: number }) => ({
        ...(value.limit !== undefined ? { limit: value.limit } : {}),
        ...(value.sharedGroupId ? { sharedGroupId: value.sharedGroupId } : {}),
        ...(value.groupLimit !== undefined ? { groupLimit: value.groupLimit } : {}),
      });
      const resolveKey = () => {
        const latest = entryNow();
        if (endpointChanged(latest)) throw new RuntimeError('model_changed', `Model ${entry.id} endpoint or protocol changed while this request waited; it will be re-prepared`);
        const binding = resolveBinding();
        if (!binding) throw new RuntimeError('model_unavailable', `No credential bound for model ${entry.id}`);
        return binding.apiKey;
      };
      const binding = resolveBinding();
      if (!binding) throw new RuntimeError('model_unavailable', `No credential bound for model ${entry.id}`);
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
      const slot = binding && scheduler && (binding.limit !== undefined || binding.groupLimit !== undefined)
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
                  if (endpointChanged(entryNow())) throw new RuntimeError('model_changed', `Model ${entry.id} endpoint or protocol changed while this request waited; it will be re-prepared`);
                  const current = resolveBinding();
                  if (!current) throw new RuntimeError('model_unavailable', `No credential bound for model ${entry.id}`);
                  const request = { credentialId: current.credentialId, apiKey: current.apiKey, ...bindingLimits(current) };
                  releaseCredential = await scheduler.acquire({
                    ...request,
                    refresh: () => {
                      const live = resolveBinding();
                      return live ? { credentialId: live.credentialId, apiKey: live.apiKey, ...bindingLimits(live) } : request;
                    },
                  }, signal);
                  const after = resolveBinding();
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
      const task = options.store.task(operation.taskId);
      const project = options.store.db.prepare('SELECT root FROM projects WHERE id=?').get(task.project_id) as { root: string };
      const definitionVersion = instance.definition_version ?? 'unknown@1';
      return async () => {
        const gate = taskGate(options.store, { id: operation.id, taskId: operation.taskId, instanceId: operation.instanceId!, nodeId: operation.nodeId }, entry);
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
        // Discussion turns must investigate without modifying the project; the
        // same read-only boundary applies to conversation masters after the
        // draft is confirmed.
        const discussion = spec.role === 'master' && (task.phase === 'chatting' || task.phase === 'discussing');
        const conversation = task.phase === 'chatting' ? conversationForTask(options.store, operation.taskId) : undefined;
        const workspace = await realpath(operation.workspace ?? project.root);
        let submitted: Json | undefined;
        let permissionRequest: CapabilityPermissionRequest | undefined;
        let modelAccessQuestion: Json | undefined;
        const channels = options.channels;
        let capabilityOperation: CapabilityOperation;
        let commands: Awaited<ReturnType<typeof openWorkspaceCommandRunner>> | undefined;
        const retrieval = options.network?.retrievalDomains?.length
          ? createRetrievalBroker({ domains: options.network.retrievalDomains, gate })
          : undefined;
        try {
          const bundle = await openCapabilityBundle({
            catalog: options.catalog,
            ...(instance.definition_version ? { definitionVersion: instance.definition_version } : {}),
            bootstrap: {
              ...(instance.definition_version && options.channels?.bootstrapPrompts?.[instance.definition_version.split('@')[0]!]
                ? { agent: options.channels.bootstrapPrompts[instance.definition_version.split('@')[0]!]! }
                : {}),
              ...(options.channels?.bootstrapToolPrompt ? { tool: options.channels.bootstrapToolPrompt } : {}),
            },
            ...(options.network?.mcpDomains?.length ? { mcpDomains: options.network.mcpDomains } : {}),
          });
          commands = await openWorkspaceCommandRunner({ workspace, scratchDir: join(options.instancesDir, operation.instanceId!, 'command-scratch'), gate });
          capabilityOperation = await bundle.openOperation({
            workspace,
            scratchDir: join(options.instancesDir, operation.instanceId!, 'capability-scratch'),
            gate,
            action: spec.action,
            ...(spec.role ? { role: spec.role } : {}),
            ...(discussion ? { readOnly: true } : {}),
            grants: operation.grants,
            onPermissionRequired: request => { permissionRequest ??= request; },
            hostTools: ({ readRoots }) => agentTools({
              workspace, ...(spec.role ? { role: spec.role } : {}),
              ...(discussion ? { readOnly: true } : {}),
              ...(readRoots.length ? { readRoots: [...readRoots] } : {}),
              run: (command, args) => commands!.run(command, args),
              ...(retrieval ? { fetch: (url: string) => retrieval.fetch(url) } : {}),
              ...(channels ? { supervisor: channels.supervisor(operation.taskId), catalog: channels.catalog } : {}),
              ...(channels?.systemContext ? {
                systemContext: {
                  ...(channels.systemContext.systemSummary ? { systemSummary: channels.systemContext.systemSummary } : {}),
                  ...(conversation && spec.role === 'master' ? {
                    requestModelAccess: async (request: { modelId: string; reason: string; planId?: string }) => {
                      const data = {
                        requestType: 'model_access',
                        modelId: request.modelId,
                        reason: request.reason,
                        ...(request.planId ? { planId: request.planId } : {}),
                        prompt: `任务需要模型 ${request.modelId}。原因：${request.reason}。请先在“设置 · 模型”中配置对应订阅或模型，然后在此确认。`,
                      } as Json;
                      modelAccessQuestion ??= data;
                      return data as Record<string, unknown>;
                    },
                  } : {}),
                },
              } : {}),
              onSubmit: output => { submitted = output; },
              ...(conversation && spec.role === 'master' ? { onSuggestedPrompt: prompt => { suggestedPrompt = prompt; } } : {}),
            }),
          });
        } catch (error) {
          // A missing or unsupported bound capability stops this node with a concrete
          // reason instead of silently running without the definition's capabilities.
          await commands?.close().catch(() => undefined);
          return { outcome: 'failed', output: { setupError: String(error) }, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
        }
        const tools = [...capabilityOperation.tools];
        const thinkingLevel = (conversation?.thinking_level ?? 'off') as ThinkingLevel;
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
          operationId: operation.id, readOnly: Boolean(discussion), report: capabilityOperation.report,
          digest: capabilityOperation.bundleDigest,
          toolPolicyDigest: capabilityOperation.toolPolicyDigest,
          runtimePolicyDigest: capabilityOperation.runtimePolicyDigest,
        });
        // Live conversation text and tool activity are separate from the final
        // message: deltas are coalesced for reconnect, the durable assistant
        // record is written by the kernel when the operation settles.
        const streamed = { text: '', buffer: '', lastFlush: 0 };
        const flushDeltas = (force: boolean) => {
          if (!conversation || !streamed.buffer) return;
          const now = Date.now();
          if (!force && now - streamed.lastFlush < 150) return;
          const text = streamed.buffer;
          streamed.buffer = '';
          streamed.lastFlush = now;
          options.store.event(operation.taskId, 'message.delta', { operationId: operation.id, text });
        };
        const toolSummaries = new Map<string, string>();
        const toolActivity: { toolCallId: string; name: string; summary: string; state: 'done' | 'error' }[] = [];
        let suggestedPrompt: string | undefined;
        const persistEntries = !conversation;
        let sawAssistantMessageEnd = false;
        const onEvent = (event: AgentSessionEvent) => {
          if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
            streamed.text += event.assistantMessageEvent.delta;
            streamed.buffer += event.assistantMessageEvent.delta;
            flushDeltas(false);
            return;
          }
          if (persistEntries && event.type === 'message_end') {
            // Real assistant message from the Pi session, not a fabricated
            // summary of the final output.
            const message = (event as unknown as { message?: { role?: string; content?: { type?: string; text?: string }[] } }).message;
            const text = (message?.content ?? []).filter(part => part.type === 'text' && typeof part.text === 'string').map(part => part.text!).join('');
            if (message?.role === 'assistant' && text.trim()) {
              sawAssistantMessageEnd = true;
              appendNodeEntry(options.store, {
                taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                activationId: operation.activationId, operationId: operation.id, role: 'assistant', kind: 'message', text,
              });
            }
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
            gate.setPurpose('compaction');
            options.store.event(operation.taskId, 'session.compaction_started', {
              nodeId: operation.nodeId, operationId: operation.id, reason: event.reason,
            });
            return;
          }
          if (event.type === 'compaction_end') {
            gate.setPurpose('completion');
            if (!event.aborted && event.result) {
              const data = {
                reason: event.reason, operationId: operation.id,
                tokensBefore: event.result.tokensBefore,
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
            }
            return;
          }
          if (!conversation) return;
          if (event.type === 'tool_execution_start') {
            if (event.toolName === 'suggest_prompt') return;
            const summary = summarizeToolCall(event.toolName, event.args);
            toolSummaries.set(event.toolCallId, summary);
            options.store.event(operation.taskId, 'message.tool', { operationId: operation.id, phase: 'start', toolCallId: event.toolCallId, toolName: event.toolName, summary });
          } else if (event.type === 'tool_execution_end') {
            if (event.toolName === 'suggest_prompt') return;
            const summary = toolSummaries.get(event.toolCallId) ?? event.toolName;
            toolActivity.push({ toolCallId: event.toolCallId, name: event.toolName, summary, state: event.isError ? 'error' : 'done' });
            options.store.event(operation.taskId, 'message.tool', { operationId: operation.id, phase: 'end', toolCallId: event.toolCallId, toolName: event.toolName, summary, isError: event.isError });
          }
        };
        try {
          const session = await openPiProcess({
            binding: { instanceId: operation.instanceId!, nodeId: operation.nodeId, definitionVersion },
            workspace, stateDir: join(options.instancesDir, operation.instanceId!),
            model: toPiModel(entry), stream: controlledOpenAIStream(observedGate, resolveKey, slot, entry.api),
            thinkingLevel,
            tools,
            allowedToolNames: [...capabilityOperation.allowedToolNames],
            ...(capabilityOperation.skillPaths.length ? { skillPaths: [...capabilityOperation.skillPaths] } : {}),
            ...(capabilityOperation.piExtensionPaths.length ? { piExtensionPaths: [...capabilityOperation.piExtensionPaths] } : {}),
            piExtensionTools: [...capabilityOperation.piExtensionTools],
            systemPrompt: capabilityOperation.prompts.system,
            appendSystemPrompt: capabilityOperation.prompts.appendSystem,
            bundleDigest: capabilityOperation.bundleDigest,
            legacyCapabilityDigest: capabilityOperation.legacyPromptDigest,
            toolPolicyDigest: capabilityOperation.toolPolicyDigest,
            runtimePolicyDigest: capabilityOperation.runtimePolicyDigest,
            ...(agentContext?.reviewPolicy ? { freshSession: true } : {}),
            ...(agentContext?.mode === 'fork' && agentContext.sourceSessionFile
              ? { forkFrom: { sessionFile: agentContext.sourceSessionFile, ...(agentContext.sourceLeafId ? { leafId: agentContext.sourceLeafId } : {}) } }
              : {}),
            broker: gate,
            ...(discussion ? { readOnly: true } : {}),
            ...(conversation ? { allowWorkspaceChange: true } : {}),
            // Auto-compaction stays on for workers, reviewers and the master;
            // thresholds follow the model that will receive the summary.
            compaction: compactionSettings(entry),
            onEvent,
            ...(conversation ? { allowWorkspaceChange: true } : {}),
          });
          activeInstances.set(operation.id, session);
          if (persistEntries) {
            const inspected = session.inspect();
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
            const briefing = operation.context.briefing ?? `Continue work for ${operation.nodeId}`;
            // Order matches the harness directory: implementation first, independent review second.
            const models = options.directory().map((entry, index) => `${index === 0 ? 'implementation' : 'review'}=${entry.id} (${entry.grade})`).join(', ');
            const hint = spec.role === 'master'
              ? [
                  ...(discussion ? [
                    '\nYou are the master agent in an ongoing conversation with the user. Understand the goal, investigate the project with the read-only tools, compare options, and ask only questions whose answers change the plan. Do not modify files, run implementation commands, or claim work is done.',
                    'propose_graph creates a draft version for the user to confirm; nothing is dispatched before confirmation. When the user changes direction, propose a new draft instead of arguing for the old one (only the latest draft on the current requirement can be confirmed).',
                    'Each proposal should include a short decisions list of the binding constraints the user confirmed (for example "do not touch login.ts"); update or drop entries when the user revises them. The list is frozen with the draft and shown on the confirmation card, so workers receive exactly what the user reviewed.',
                    'After confirmation the graph runs as a separate feature task. Answer progress questions from the "Conversation and execution status" section of the briefing with concrete recorded facts; when the user wants to change confirmed scope, explain the impact and require an explicit new task or confirmed change.',
                    'Before proposing a graph, inspect the project and query the user capability directory with search_resources/get_resource. Every scanned capability is immediately available, but it grants no task permission; never invent capabilities from memory.',
                    'Use list_agent_combinations/get_agent_combination to inspect recipes assembled from existing capability IDs. You may save or edit recipes, but never create a new Skill, MCP, extension or identity yourself. Compile a recipe with compile_agent_combination and put the returned definitionVersion directly into propose_graph.',
                    'Use read_system_capabilities to check configured subscriptions, models, Agent definitions and graph architectures before designing or assembling the graph. If the task genuinely needs an unavailable model, call request_model_access with a concrete reason so the user can decide and configure it; never edit configuration yourself and never silently substitute an unrelated model.',
                    'For each worker, request the minimum sufficient context. Omit context for a normal fresh Agent. Use context.requiredFacts with transcript_range or tool_call only when the exact parent transcript or tool-call state is essential; Graph will then fork from context.sourceNode. Never specify a mode directly. Independent review and verification must use context.independence="model-excluded" and must not request transcript or tool-call facts.',
                    'Write normal prose replies for chat; use tools only to investigate, to record a prompt suggestion, or to submit a draft.',
                    'After writing the normal reply, call suggest_prompt with one concise and specific message the user is most likely to send next. Omit the suggestion when there is no useful follow-up. The suggestion is only a composer hint and must never be sent automatically.',
                  ] : []),
                  'Use propose_graph to submit a validated task graph. Program nodes may use graph.command with input {"command":"...","args":[...]} for allowed build/test commands (including a headless browser test), graph.verify for independent review, and graph.human_check for user checks. Use workspace tools to inspect the project.',
                  `Configured models: ${models || '(none)'}. Implementation nodes must use the implementation model and review nodes must use the review model, both from the briefing catalog (for example coder@1, reviewer@1).`,
                  'proposalJson schema:',
                  `{"requirementVersion": ${operation.requirementVersion}, "summary": "<one line>",`,
                  ' "acceptance": [{"id":"a1","description":"...","checkNode":"<mandatory program node id>"}],',
                  ' "nodes": [',
                  '  {"id":"work","kind":"agent","action":"work","definitionVersion":"coder@1","model":"<one of the configured models>"},',
                  '  {"id":"alternative","kind":"agent","action":"explore","definitionVersion":"coder@1","model":"<same model/definition as work>","dependsOn":["work"],"context":{"purpose":"explore","sourceNode":"work","requiredFacts":[{"kind":"transcript_range"}],"reason":"Continue from the exact debugging state"}},',
                  '  {"id":"check","kind":"program","action":"graph.command","dependsOn":["work"],"input":{"command":"node","args":["--test","test/example.test.js"]}},',
                  '  {"id":"review","kind":"agent","action":"review","definitionVersion":"reviewer@1","model":"<a different configured model>","dependsOn":["work"],"context":{"purpose":"review","independence":"model-excluded"}},',
                  '  {"id":"review-gate","kind":"program","action":"graph.verify","dependsOn":["review"],"verifier":{"kind":"independent","reportNodes":["review"]}},',
                  '  {"id":"login","kind":"program","action":"graph.human_check","dependsOn":["review-gate"]}],',
                  ' "loops": [{"from":"check","to":"work"}],',
                  ' "decisions": ["<binding constraint the user confirmed>"]}',
                ].join('\n')
              : `\nUse workspace tools to read and edit files. Submit structured output with submit_result when required. Start writing implementation files early and keep each turn short instead of exploring or reasoning at length; the task graph lists the exact check inputs that must exist. run_command is not a shell: it only accepts node (without inline evaluation) and read-only git status/diff/log/show.${retrieval ? ' The fetch tool reads HTTP documents from granted domains.' : ''}`;
            if (persistEntries) {
              appendNodeEntry(options.store, {
                taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                activationId: operation.activationId, operationId: operation.id, role: 'user', kind: 'briefing',
                text: `${briefing}${hint}`.slice(0, 20_000),
              });
            }
            await session.prompt(`${briefing}${hint}`);
            flushDeltas(true);
            if (gateRefusal) throw gateRefusal;
            // A provider or transport error ends the turn with an assistant
            // error message; that is a failure, never a successful operation.
            const messages = session.inspect().messages as { role?: string; stopReason?: string; errorMessage?: string }[];
            const lastAssistant = [...messages].reverse().find(message => message.role === 'assistant');
            if (lastAssistant?.stopReason === 'error') {
              return { outcome: 'failed', output: { error: lastAssistant.errorMessage ?? 'Model request failed' }, usage: gate.total() };
            }
            if (permissionRequest) {
              return {
                outcome: 'waiting', output: { permission: { grant: permissionRequest.grant, capabilityId: permissionRequest.capabilityId, tool: permissionRequest.tool } },
                question: { prompt: `Remote MCP tool ${permissionRequest.tool} requires the user grant ${permissionRequest.grant} in this task`, grant: permissionRequest.grant },
                usage: gate.total(),
              };
            }
            if (modelAccessQuestion) {
              return {
                outcome: 'waiting',
                output: { question: modelAccessQuestion },
                question: {
                  prompt: String((modelAccessQuestion as { prompt?: string }).prompt ?? 'Model access is required'),
                  data: modelAccessQuestion,
                },
                usage: gate.total(),
              };
            }
            const text = assistantText(session.inspect().messages);
            const reply = text.trim() ? text : streamed.text;
            if (persistEntries && !sawAssistantMessageEnd && reply.trim()) {
              appendNodeEntry(options.store, {
                taskId: operation.taskId, nodeId: operation.nodeId, instanceId: operation.instanceId,
                activationId: operation.activationId, operationId: operation.id, role: 'assistant', kind: 'message', text: reply,
              });
            }
            // The conversation output always carries the visible reply; worker
            // output keeps its existing submitted-or-text shape.
            const output: Json = conversation
              ? { text: reply, ...(suggestedPrompt ? { suggestedPrompt } : {}), ...(toolActivity.length ? { toolActivity: toolActivity as unknown as Json } : {}), ...(submitted !== undefined ? { submitted } : {}) }
              : (submitted ?? { text });
            return { outcome: 'completed', output, usage: gate.total() };
          } finally {
            activeInstances.delete(operation.id);
            await session.close();
          }
        } finally { await capabilityOperation.close(); await commands.close(); }
      };
    },
  };
}
