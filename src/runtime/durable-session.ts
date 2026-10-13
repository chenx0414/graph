import { loadProjectContextFiles, convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, watchEvents, type EntryRecord, type Cursor, type SubmissionRecord, type Submission } from '@earendil-works/pi-durable';
import type { AgentSession, AgentSessionInspect, AgentSessionTransport, AgentSessionRequest } from './agent-session.ts';
import { lastTurnUsage } from './agent-session.ts';
import { installDurableModel, createModels } from './durable-models.ts';
import { freezeDurableModel, freezeDurableResources, restoreDurableResources } from './durable-freeze.ts';
import { openDurableHost, type FrozenDurableExecution } from './durable-host.ts';
import { COMPACTION_INSTRUCTIONS, shouldCompactContext } from './compaction.ts';
import { legacyHistory } from './durable-history.ts';
import { openDurableTools } from './durable-tools.ts';
import type { DurablePluginContext } from './durable-plugin.ts';
import type { TaskStore } from '../core/store.ts';

/** One durable conversation transport for main and Graph nodes. Native tools
 * and capability hooks share the frozen Graph policy and provider gate. */
export async function createDurableSessionTransport(store: TaskStore): Promise<AgentSessionTransport & { host: Awaited<ReturnType<typeof openDurableHost>>; close(): Promise<void> }> {
  const host = await openDurableHost(store, createModels());
  const recovering = new Set<Promise<void>>();
  const beginRecovery = new Set<() => void>();
  const restored = new Set<() => Promise<void>>();
  const recoveredConfigurations = new Map<string, FrozenDurableExecution>();
  const factories = new Set<(snapshot: FrozenDurableExecution, receipt?: SubmissionRecord) => Promise<AgentSessionRequest | undefined>>();
  const prepare = async (request: AgentSessionRequest, restoring?: FrozenDurableExecution): Promise<AgentSession> => {
      const configuration = restoring?.configuration ?? await freezeDurableResources(request);
      {
        const policy = configuration.policy;
        const resources = await restoreDurableResources(configuration);
        const roots = [...configuration.directories ?? [], ...configuration.resources.map(resource => resource.path), ...(configuration.aliases ?? []).map(alias => alias.path)].sort((left, right) => right.length - left.length);
        const remap = (path: string) => roots.some(root => path === root || path.startsWith(root + '/')) ? resources.pathFor(path) : path;
        const settings = (value: unknown): unknown => Array.isArray(value) ? value.map(settings) : typeof value === 'string' ? remap(value) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, settings(item)])) : value;
        request = { ...request, workspace: policy.workspace, stateDir: policy.stateDir, binding: policy.binding,
          nativeTools: policy.nativeTools, allowedToolNames: policy.allowedToolNames, piExtensionTools: policy.piExtensionTools,
          skillPaths: policy.skillPaths.map(remap), ...(policy.skillFolder ? { skillFolder: remap(policy.skillFolder) } : {}), piExtensionPaths: policy.piExtensionPaths.map(remap),
          readRoots: [...policy.readRoots, resources.directory], writeRoots: policy.writeRoots, protectedPaths: [...policy.protectedPaths, resources.directory], readOnly: policy.readOnly,
          filesystemAccess: policy.filesystemAccess, allowGitMetadataWritesAll: policy.allowGitMetadataWritesAll, networkDomains: policy.networkDomains, allowUnrestrictedNetwork: policy.allowUnrestrictedNetwork,
          allowLocalBinding: policy.allowLocalBinding, unixSockets: policy.unixSockets, allowAllUnixSockets: policy.allowAllUnixSockets, allowAppleEvents: policy.allowAppleEvents,
          ...(request.mcpAdapterServers ? { mcpAdapterServers: settings(request.mcpAdapterServers) as NonNullable<AgentSessionRequest['mcpAdapterServers']> } : {}),
          frozenResourcePaths: roots.map(source => ({ source, target: resources.pathFor(source) })),
        };
      }
      const projectContext = restoring ? [] : loadProjectContextFiles({ cwd: request.workspace, agentDir: request.stateDir });
      const projectPrompt = projectContext.length ? `<project_context>\n${projectContext.map(file => `## ${file.path}\n${file.content}`).join('\n\n')}\n</project_context>` : '';
      let pendingBridge: Awaited<ReturnType<typeof openDurableTools>> | undefined;
      const model = installDurableModel(host.models, restoring?.agent.model?.provider ?? `graph-${createHash('sha256').update(JSON.stringify([request.binding.instanceId, request.executionId, request.model, request.bundleDigest, request.runtimePolicyDigest])).digest('hex')}`, request, () => pendingBridge?.stopped ?? false);
      const conversation = await host.conversation(request.binding.instanceId, { model, instructions: request.systemPrompt ?? '', cwd: request.workspace }, await legacyHistory(request));
      const snapshot = async (): Promise<DurablePluginContext> => {
        const history: EntryRecord[] = [];
        let cursor: Cursor | undefined;
        do { const page = await conversation.entries({ order: 'ascending' }, 500, cursor, BACKGROUND_CONTEXT); history.push(...page.items); cursor = page.next; } while (cursor);
        const context = await conversation.context(BACKGROUND_CONTEXT);
        const project = (entries: readonly EntryRecord[]) => {
          let parentId: string | null = null;
          return entries.flatMap(entry => (entry.model ?? []).map((message, index) => {
            const id = `${entry.id}:${index}`;
            const value = { type: 'message', id, parentId, timestamp: new Date(message.timestamp).toISOString(), message };
            parentId = id; return value;
          }));
        };
        const branch = project(context.entries);
        const tokens = Math.ceil(JSON.stringify(context.messages).length / 4);
        return { entries: project(history), branch, sessionId: String(conversation.id), leafId: branch.at(-1)?.id ?? null, model: request.model, contextUsage: { tokens, contextWindow: request.model.contextWindow, percent: tokens / request.model.contextWindow * 100 } };
      };
      const bridge = pendingBridge = await openDurableTools(request, request.piExtensionPaths?.length ? { context: await snapshot(), refreshContext: snapshot } : {});
      const instructions = restoring?.agent.instructions ?? [request.systemPrompt ?? '', projectPrompt, bridge.skillsPrompt, `<cwd>${request.workspace}</cwd>`].filter(Boolean).join('\n\n');
      const extension = defineExtension({ name: restoring?.extensionName ?? `graph-tools-${createHash('sha256').update(JSON.stringify([request.binding.instanceId, request.executionId, request.bundleDigest, request.toolPolicyDigest, request.runtimePolicyDigest])).digest('hex')}`, tools: bridge.tools });
      host.registry.install(extension);
      if (!restoring) await host.recover({ request, instructions, configuration });
      // Unknown admissions used an inspection gate while their old receipt
      // drained. A distinct, authorized continuation gets its live Graph gate.
      installDurableModel(host.models, model.provider, request, () => pendingBridge?.stopped ?? false);
      host.registry.install(extension);
      const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
      const busy = inspection.tasks.some(task => task.record.conversationId === conversation.id) || inspection.submissions.some(input => input.conversationId === conversation.id);
      if (busy) {
        const current = await conversation.agent(BACKGROUND_CONTEXT);
        if (current.model?.provider !== model.provider || current.model.modelId !== model.modelId || current.instructions !== instructions || current.cwd !== request.workspace) throw new Error('Cannot replace the frozen configuration of an active durable execution');
      } else await conversation.configure({ model, instructions, cwd: request.workspace, tools: bridge.tools, extensions: [extension],
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}) }, BACKGROUND_CONTEXT);
      const freeze = async (effectiveInstructions: string) => host.freeze(conversation.id, {
        identity: request.binding.instanceId, executionId: request.executionId ?? '', ...(restoring?.originalInputRequestId ? { originalInputRequestId: restoring.originalInputRequestId } : {}), inputRequestId: request.inputRequestId ?? request.executionId ?? '',
        preAdmissionInvocationIds: restoring?.preAdmissionInvocationIds ?? (store.db.prepare('SELECT id FROM invocations WHERE operation_id=? AND usage IS NOT NULL').all(request.executionId ?? '') as { id: string }[]).map(call => call.id),
        model: freezeDurableModel(request.model).model, agent: { model, instructions: effectiveInstructions, cwd: request.workspace }, extensionName: extension.name,
        tools: bridge.tools.map(tool => JSON.parse(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }))), configuration,
      });
      if (!busy) await freeze(instructions);
      let messages: unknown[] = [...(await conversation.context(BACKGROUND_CONTEXT)).messages];
      let closed = false;
      let interrupted = false;
      let continuation: Promise<Submission> | undefined;
      let acceptingInput = false;
      const pendingContinuation = () => continuation;
      const inspect = (): AgentSessionInspect => ({ binding: request.binding, sessionId: String(conversation.id), sessionFile: `durable:${conversation.id}`,
        model: request.model.id, messages, leafId: null, bundleDigest: request.bundleDigest, toolPolicyDigest: request.toolPolicyDigest,
        runtimePolicyDigest: request.runtimePolicyDigest, piVersion: '1.1.0', activeTools: bridge.activeTools, registeredTools: bridge.activeTools, loadedExtensions: bridge.loadedExtensions, extensionErrors: bridge.extensionErrors });
      const checked = () => { if (closed) throw new Error('Durable agent session is closed'); };
      const compact = async (instructions?: string, reason: 'manual' | 'threshold' | 'overflow' = 'manual') => {
          checked();
          request.onEvent?.({ type: 'compaction_start', reason });
          try {
            const before = await conversation.context(BACKGROUND_CONTEXT);
            const task = await conversation.compact(instructions, BACKGROUND_CONTEXT);
            const result = await host.harness.waitForTask(task, BACKGROUND_CONTEXT);
            if (result.state.outcome?.status !== 'completed') throw new Error(`Compaction failed: ${result.state.outcome?.status === 'faulted' || result.state.outcome?.status === 'failed' ? result.state.outcome.error.message : result.state.outcome?.status ?? 'unknown'}`);
            const current = await conversation.context(BACKGROUND_CONTEXT);
            messages = [...current.messages];
            const summary = current.head?.model?.find(message => message.role === 'user');
            if (!summary || !current.head) throw new Error('Nothing to compact');
            request.onEvent?.({ type: 'compaction_end', reason, aborted: false, willRetry: false, result: { summary: typeof summary.content === 'string' ? summary.content : summary.content.filter(part => part.type === 'text').map(part => part.text).join(''), firstKeptEntryId: String(current.head.head ?? current.head.id), tokensBefore: Math.ceil(JSON.stringify(before.messages).length / 4), estimatedTokensAfter: Math.ceil(JSON.stringify(current.messages).length / 4) } });
          } catch (error) { request.onEvent?.({ type: 'compaction_end', reason, aborted: false, willRetry: false, result: undefined, errorMessage: String(error) }); throw error; }
      };
      return {
        inspect,
        async prompt(text, images) {
          checked();
          interrupted = false; continuation = undefined; acceptingInput = true;

          const plugin = await bridge.beforePrompt(text, images);
          if (plugin.systemPrompt !== undefined && plugin.systemPrompt !== request.systemPrompt) await conversation.configure({ instructions: [plugin.systemPrompt, projectPrompt, bridge.skillsPrompt, `<cwd>${request.workspace}</cwd>`].filter(Boolean).join('\n\n') }, BACKGROUND_CONTEXT);
          if (plugin.messages.length) {
            const context = convertToLlm(plugin.messages.map(message => ({ ...message as { customType: string; content: string }, role: 'custom', timestamp: Date.now(), display: false })) as Parameters<typeof convertToLlm>[0]);
            await conversation.commit(async tx => { for (const message of context) await tx.appendEntry(conversation.id, { kind: 'graph.plugin-message', model: [message] }); }, BACKGROUND_CONTEXT);
          }
          const events = await watchEvents(host.harness, conversation.id, BACKGROUND_CONTEXT);
          let partial: AssistantMessage | undefined;
          const delivered = new Map<number, string>();
          const deltas = (message: AssistantMessage) => {
            for (const [contentIndex, block] of message.content.entries()) {
              if (block.type !== 'text') continue;
              const previous = delivered.get(contentIndex) ?? '';
              const delta = block.text.startsWith(previous) ? block.text.slice(previous.length) : block.text;
              delivered.set(contentIndex, block.text);
              if (delta) request.onEvent?.({ type: 'message_update', message, assistantMessageEvent: { type: 'text_delta', contentIndex, delta, partial: message } });
            }
          };
          events.start(async batch => {
            for (const event of batch) {
              if (event.type !== 'snapshot') await bridge.onEvent({ ...event, type: event.type === 'run_start' ? 'agent_start' : event.type === 'run_end' ? 'agent_end' : event.type });
              if (event.type === 'message_start') {
                if (event.message.role === 'assistant') { partial = structuredClone(event.message); delivered.clear(); deltas(partial); }
                request.onEvent?.({ type: 'message_start', message: event.message });
              }
              if (event.type === 'message_update') for (const change of event.changes) {
                if (!partial) continue;
                if (change.type === 'message') partial = structuredClone(change.message);
                if ('block' in change) partial.content[change.contentIndex] = structuredClone(change.block);
                if (change.type === 'text_delta') {
                  const block = partial.content[change.contentIndex];
                  if (block?.type === 'text') block.text += change.delta;
                  partial.usage = event.usage;

                }
                deltas(partial);
              }
              if (event.type === 'tool_execution_start') request.onEvent?.({ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
              if (event.type === 'tool_execution_end') {
                const result = event.entry?.model?.find(message => message.role === 'toolResult');
                request.onEvent?.({ type: 'tool_execution_end', toolCallId: event.toolCallId, toolName: event.toolName, result: result ? { content: result.content, details: event.entry?.data } : { content: [] }, isError: result?.isError ?? true });
              }
              if (event.type === 'message_end') for (const message of event.entry.model ?? []) { if (message.role === 'assistant') deltas(message); request.onEvent?.({ type: 'message_end', message }); }
            }
          });
          try {
            await freeze(plugin.systemPrompt !== undefined && plugin.systemPrompt !== request.systemPrompt ? [plugin.systemPrompt, projectPrompt, bridge.skillsPrompt, `<cwd>${request.workspace}</cwd>`].filter(Boolean).join('\n\n') : instructions);
            const existing = await conversation.commit(tx => tx.submissionByRequest(conversation.id, request.inputRequestId ?? request.executionId ?? ''), BACKGROUND_CONTEXT);
            const admitted = existing ? await host.harness.submission(existing.id, BACKGROUND_CONTEXT) : undefined;
            const input = admitted ?? await conversation.submit({ type: 'input', content: images?.length ? [{ type: 'text', text }, ...images] : text, requestId: request.inputRequestId ?? request.executionId ?? randomUUID(), whenBusy: 'reject' }, BACKGROUND_CONTEXT);
            let result = await input.wait(BACKGROUND_CONTEXT);
            let awaitedReplacement: Promise<Submission> | undefined;
            let replacement = pendingContinuation();
            while (replacement && replacement !== awaitedReplacement) {
              awaitedReplacement = replacement;
              result = await (await replacement).wait(BACKGROUND_CONTEXT);
              replacement = pendingContinuation();
            }
            acceptingInput = false;
            messages = [...(await conversation.context(BACKGROUND_CONTEXT)).messages];
            const last = [...messages].reverse().find(message => typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant');
            const assistantText = last && typeof last === 'object' && 'content' in last && Array.isArray(last.content)
              ? last.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
            const usage = lastTurnUsage(inspect());
            if (!bridge.stopped && request.compaction?.enabled && result.status === 'unanswered' && /maximum context|context length|context window/i.test(JSON.stringify(result.detail))) {
              try { await compact(COMPACTION_INSTRUCTIONS, 'overflow'); } catch { /* Graph owns the subsequent retry or pause; never replay this input here. */ }
            }
            const estimated = Math.ceil(JSON.stringify(messages.filter(message => !(message && typeof message === 'object' && 'role' in message && message.role === 'system'))).length / 4);
            if (!bridge.stopped && request.compaction?.enabled && shouldCompactContext(request.model, usage?.total ?? estimated)) {
              try { await compact(COMPACTION_INSTRUCTIONS, 'threshold'); } catch { /* completed reply remains valid; Graph retries compaction before the next turn */ }
            }
            return { inspect: inspect(), finalAssistantText: assistantText, stopReason: bridge.stopped ? 'stop' : interrupted && !continuation ? 'aborted' : result.status === 'done' && last && typeof last === 'object' && 'stopReason' in last ? last.stopReason as AssistantMessage['stopReason'] : result.status === 'done' ? 'stop' : 'error',
              ...(result.status === 'done' || bridge.stopped ? {} : { errorMessage: String(result.detail ?? result.reason) }), usage };
          } finally { acceptingInput = false; await events.stop(); }
        },
        compact,
        async steer(text) { checked(); if (!acceptingInput) throw new Error('The main turn is no longer accepting steering messages'); await conversation.submit({ type: 'input', content: text, requestId: `${restoring?.originalInputRequestId ?? request.inputRequestId ?? request.executionId}:continuation:${randomUUID()}`, whenBusy: 'steer' }, BACKGROUND_CONTEXT); },
        async interrupt(text) {
          checked(); if (!acceptingInput) throw new Error('The main turn is no longer accepting interruption'); interrupted = true;
          const next = text ? Promise.withResolvers<Submission>() : undefined;
          continuation = next?.promise;
          try {
            await conversation.abort(BACKGROUND_CONTEXT);
            if (next) next.resolve(await conversation.submit({ type: 'input', content: text!, requestId: `${restoring?.originalInputRequestId ?? request.inputRequestId ?? request.executionId}:continuation:${randomUUID()}` }, BACKGROUND_CONTEXT));
          } catch (error) { next?.reject(error); throw error; }
        },
        async stop() { if (closed) return; bridge.stop(); if (!bridge.runningTools) await conversation.abort(BACKGROUND_CONTEXT); },
        async close() { closed = true; await bridge.close(); },
      };
  };
  host.setRecoveryLoader(async snapshot => {
    for (const factory of factories) {
      const original = await host.findConversation(snapshot.identity);
      const receipt = original && await original.commit(tx => tx.submissionByRequest(original.id, snapshot.inputRequestId), BACKGROUND_CONTEXT);
      const request = await factory(snapshot, receipt);
      if (!request) continue;
      if (request.executionId !== snapshot.executionId || request.binding.instanceId !== snapshot.identity || JSON.stringify(freezeDurableModel(request.model).model) !== JSON.stringify(snapshot.model)) throw new Error('Recovery factory changed an original admission');
      if (receipt?.type === 'input' && receipt.status === 'done' && request.onRecoveryComplete && original) {
        const answer = await original.commit(tx => tx.entry(receipt.answer), BACKGROUND_CONTEXT);
        const assistant = answer?.model?.find((message): message is AssistantMessage => message.role === 'assistant');
        if (!assistant) throw new Error('Completed durable receipt has no assistant answer');
        beginRecovery.add(() => {
          const completed = (async () => {
            const context = await original.context(BACKGROUND_CONTEXT);
            request.onEvent?.({ type: 'message_start', message: assistant });
            request.onEvent?.({ type: 'message_end', message: assistant });
            await request.onRecoveryComplete!({ inspect: { binding: request.binding, sessionId: String(original.id), sessionFile: `durable:${original.id}`, model: request.model.id, messages: [...context.messages], leafId: null, bundleDigest: request.bundleDigest, toolPolicyDigest: request.toolPolicyDigest, runtimePolicyDigest: request.runtimePolicyDigest, piVersion: '1.1.0' }, finalAssistantText: assistant.content.filter(part => part.type === 'text').map(part => part.text).join(''), stopReason: assistant.stopReason });
          })();
          recovering.add(completed);
          void completed.finally(() => { recovering.delete(completed); }).catch(() => undefined);
        });
        return { request, instructions: snapshot.agent.instructions ?? '', configuration: snapshot.configuration };
      }
      recoveredConfigurations.set(snapshot.executionId, snapshot);
      const session = await prepare({ ...request, inputRequestId: snapshot.inputRequestId }, snapshot);
      restored.add(async () => { try { await session.close(); } finally { await request.onRecoveryClose?.(); } });
      if (request.onRecoveryComplete) {
        const conversation = await host.findConversation(snapshot.identity);
        if (!conversation) throw new Error('Original recovery conversation is missing');
        const receipt = await conversation.commit(tx => tx.submissionByRequest(conversation.id, snapshot.inputRequestId), BACKGROUND_CONTEXT);
        if (!receipt) throw new Error('Original recovery input receipt is missing');
        const input = await host.harness.submission(receipt.id, BACKGROUND_CONTEXT);
        if (!input) throw new Error('Original recovery input is missing');
        const events = await watchEvents(host.harness, conversation.id, BACKGROUND_CONTEXT);
        let assistant: AssistantMessage | undefined;
        if (receipt.type === 'input' && receipt.status === 'done') { const answer = await conversation.commit(tx => tx.entry(receipt.answer), BACKGROUND_CONTEXT); assistant = answer?.model?.find((message): message is AssistantMessage => message.role === 'assistant'); }
        events.start(async batch => {
          for (const event of batch) {
            if (event.type === 'message_start') request.onEvent?.({ type: 'message_start', message: event.message });
            if (event.type === 'message_end') for (const message of event.entry.model ?? []) {
              if (message.role === 'assistant') assistant = message;
              request.onEvent?.({ type: 'message_end', message });
            }
            if (event.type === 'tool_execution_start') request.onEvent?.({ type: 'tool_execution_start', toolCallId: event.toolCallId, toolName: event.toolName, args: event.args });
          }
        });
        beginRecovery.add(() => {
          const completed = (async () => {
            try {
              const result = await input.wait(BACKGROUND_CONTEXT);
              await events.stop();
              if (result.status === 'done') {
                // Event delivery can lag the settled input under load. The
                // original durable answer is the authoritative completion.
                const settled = await conversation.commit(tx => tx.submissionByRequest(conversation.id, snapshot.inputRequestId), BACKGROUND_CONTEXT);
                if (settled?.type !== 'input' || settled.status !== 'done') throw new Error('Recovered input lacks its completed receipt');
                const answer = await conversation.commit(tx => tx.entry(settled.answer), BACKGROUND_CONTEXT);
                assistant = answer?.model?.find((message): message is AssistantMessage => message.role === 'assistant');
              }
              const finalAssistantText = assistant?.content.filter(part => part.type === 'text').map(part => part.text).join('') ?? '';
              await request.onRecoveryComplete!({ inspect: session.inspect(), finalAssistantText, stopReason: result.status === 'done' ? assistant?.stopReason ?? 'stop' : 'error',
                ...(result.status === 'done' && assistant ? {} : { errorMessage: String(result.status === 'done' ? 'Recovered input has no new assistant response' : result.detail ?? result.reason) }) });
            } finally { await events.stop(); }
          })();
          recovering.add(completed);
          void completed.finally(() => { recovering.delete(completed); }).catch(() => undefined);
        });
      }
      return { request, instructions: snapshot.agent.instructions ?? '', configuration: snapshot.configuration };
    }
    return undefined;
  });
  return { host, close: async () => { try { await host.close(); } finally { await Promise.allSettled([...recovering]); await Promise.allSettled([...restored].map(close => close())); restored.clear(); } }, recoverableInput: host.recoverableInput, open: request => prepare(request, request.executionId ? recoveredConfigurations.get(request.executionId) : undefined),
    async bootstrapRecovery() { await host.recover(); for (const begin of beginRecovery) begin(); beginRecovery.clear(); host.harness.resume(); },
    async waitForRecovery() { await Promise.all([...recovering]); },
    registerRecoveryFactory(factory) { factories.add(factory); return () => { factories.delete(factory); }; },
  };
}
