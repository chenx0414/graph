import { loadProjectContextFiles, convertToLlm } from '@earendil-works/pi-coding-agent';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { defineExtension, watchEvents, type EntryRecord, type Cursor } from '@earendil-works/pi-durable';
import type { AgentSession, AgentSessionInspect, AgentSessionTransport } from './agent-session.ts';
import { lastTurnUsage } from './agent-session.ts';
import { installDurableModel, createModels } from './durable-models.ts';
import { openDurableHost } from './durable-host.ts';
import { COMPACTION_INSTRUCTIONS, shouldCompactContext } from './compaction.ts';
import { legacyHistory } from './durable-history.ts';
import { openDurableTools } from './durable-tools.ts';
import type { DurablePluginContext } from './durable-plugin.ts';
import type { TaskStore } from '../core/store.ts';

/** One durable conversation transport for main and Graph nodes. Native tools
 * and capability hooks share the frozen Graph policy and provider gate. */
export async function createDurableSessionTransport(store: TaskStore): Promise<AgentSessionTransport & { host: Awaited<ReturnType<typeof openDurableHost>>; close(): Promise<void> }> {
  const host = await openDurableHost(store, createModels());
  return {
    host,
    close: () => host.close(),
    async open(request): Promise<AgentSession> {
      const projectContext = loadProjectContextFiles({ cwd: request.workspace, agentDir: request.stateDir });
      const projectPrompt = projectContext.length ? `<project_context>\n${projectContext.map(file => `## ${file.path}\n${file.content}`).join('\n\n')}\n</project_context>` : '';
      let pendingBridge: Awaited<ReturnType<typeof openDurableTools>> | undefined;
      const model = installDurableModel(host.models, `graph-${createHash('sha256').update(JSON.stringify([request.binding.instanceId, request.executionId, request.model, request.bundleDigest, request.runtimePolicyDigest])).digest('hex')}`, request, () => pendingBridge?.stopped ?? false);
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
      const instructions = [request.systemPrompt ?? '', projectPrompt, bridge.skillsPrompt, `<cwd>${request.workspace}</cwd>`].filter(Boolean).join('\n\n');
      const extension = defineExtension({ name: `graph-tools-${createHash('sha256').update(JSON.stringify([request.binding.instanceId, request.executionId, request.bundleDigest, request.toolPolicyDigest, request.runtimePolicyDigest])).digest('hex')}`, tools: bridge.tools });
      host.registry.install(extension);
      const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
      const busy = inspection.tasks.some(task => task.record.conversationId === conversation.id) || inspection.submissions.some(input => input.conversationId === conversation.id);
      if (busy) {
        const current = await conversation.agent(BACKGROUND_CONTEXT);
        if (current.model?.provider !== model.provider || current.model.modelId !== model.modelId || current.instructions !== instructions || current.cwd !== request.workspace) throw new Error('Cannot replace the frozen configuration of an active durable execution');
      } else await conversation.configure({ model, instructions, cwd: request.workspace, tools: bridge.tools, extensions: [extension],
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}) }, BACKGROUND_CONTEXT);
      let messages: unknown[] = [...(await conversation.context(BACKGROUND_CONTEXT)).messages];
      let closed = false;
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

          const plugin = await bridge.beforePrompt(text, images);
          if (plugin.systemPrompt !== undefined && plugin.systemPrompt !== request.systemPrompt) await conversation.configure({ instructions: [plugin.systemPrompt, projectPrompt, bridge.skillsPrompt, `<cwd>${request.workspace}</cwd>`].filter(Boolean).join('\n\n') }, BACKGROUND_CONTEXT);
          if (plugin.messages.length) {
            const context = convertToLlm(plugin.messages.map(message => ({ ...message as { customType: string; content: string }, role: 'custom', timestamp: Date.now(), display: false })) as AgentMessage[]);
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
            const input = await conversation.submit({ type: 'input', content: images?.length ? [{ type: 'text', text }, ...images] : text, requestId: request.inputRequestId ?? request.executionId ?? randomUUID(), whenBusy: 'reject' }, BACKGROUND_CONTEXT);
            const result = await input.wait(BACKGROUND_CONTEXT);
            messages = [...(await conversation.context(BACKGROUND_CONTEXT)).messages];
            const last = [...messages].reverse().find(message => typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant');
            const assistantText = last && typeof last === 'object' && 'content' in last && Array.isArray(last.content)
              ? last.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
            const usage = lastTurnUsage(inspect());
            const estimated = Math.ceil(JSON.stringify(messages.filter(message => !(message && typeof message === 'object' && 'role' in message && message.role === 'system'))).length / 4);
            if (!bridge.stopped && request.compaction?.enabled && shouldCompactContext(request.model, usage?.total ?? estimated)) {
              try { await compact(COMPACTION_INSTRUCTIONS, 'threshold'); } catch { /* completed reply remains valid; Graph retries compaction before the next turn */ }
            }
            return { inspect: inspect(), finalAssistantText: assistantText, stopReason: bridge.stopped ? 'stop' : result.status === 'done' && last && typeof last === 'object' && 'stopReason' in last ? last.stopReason as AssistantMessage['stopReason'] : result.status === 'done' ? 'stop' : 'error',
              ...(result.status === 'done' || bridge.stopped ? {} : { errorMessage: String(result.detail ?? result.reason) }), usage };
          } finally { await events.stop(); }
        },
        compact,
        async steer(text) { checked(); await conversation.submit({ type: 'input', content: text, whenBusy: 'steer' }, BACKGROUND_CONTEXT); },
        async interrupt(text) { checked(); await conversation.abort(BACKGROUND_CONTEXT); if (text) await conversation.submit({ type: 'input', content: text }, BACKGROUND_CONTEXT); },
        async stop() { if (closed) return; bridge.stop(); if (!bridge.runningTools) await conversation.abort(BACKGROUND_CONTEXT); },
        async close() { closed = true; await bridge.close(); },
      };
    },
  };
}
