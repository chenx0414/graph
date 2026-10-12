import { loadSkills } from '@earendil-works/pi-coding-agent';
import { createHash, randomUUID } from 'node:crypto';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import { watchEvents } from '@earendil-works/pi-durable';
import type { AgentSession, AgentSessionInspect, AgentSessionTransport } from './agent-session.ts';
import { lastTurnUsage } from './agent-session.ts';
import { installDurableModel, createModels } from './durable-models.ts';
import { openDurableHost } from './durable-host.ts';
import type { TaskStore } from '../core/store.ts';

/** Shared text transport foundation. Bound capabilities are explicitly refused
 * until the capability bridge installs them; they are never silently dropped. */
export async function createDurableSessionTransport(store: TaskStore): Promise<AgentSessionTransport & { close(): Promise<void> }> {
  const host = await openDurableHost(store, createModels());
  return {
    close: () => host.close(),
    async open(request): Promise<AgentSession> {
      if (request.nativeTools?.length || request.tools?.length || request.piExtensionPaths?.length || request.mcpAdapterServers?.length) {
        throw new Error(`Durable capability bridge has not installed: ${JSON.stringify({ nativeTools: request.nativeTools, tools: request.tools?.map(tool => tool.name), skills: request.skillPaths, extensions: request.piExtensionPaths, mcp: request.mcpAdapterServers?.map(server => server.name) })}`);
      }
      const skills = loadSkills({ cwd: request.workspace, agentDir: request.stateDir, includeDefaults: false, skillPaths: [...(request.skillPaths ?? []), ...(request.skillFolder ? [request.skillFolder] : [])] });
      if (skills.skills.length) throw new Error('Durable Skill bridge has not installed the bound Skills');
      const model = installDurableModel(host.models, `graph-${createHash('sha256').update(JSON.stringify([request.binding.instanceId, request.executionId, request.model, request.bundleDigest, request.runtimePolicyDigest])).digest('hex')}`, request);
      const conversation = await host.conversation(request.binding.instanceId, { model, instructions: request.systemPrompt ?? '', cwd: request.workspace, tools: [], extensions: [] });
      const inspection = await host.harness.inspect(BACKGROUND_CONTEXT);
      const busy = inspection.tasks.some(task => task.record.conversationId === conversation.id) || inspection.submissions.some(input => input.conversationId === conversation.id);
      if (busy) {
        const current = await conversation.agent(BACKGROUND_CONTEXT);
        if (current.model?.provider !== model.provider || current.model.modelId !== model.modelId || current.instructions !== (request.systemPrompt ?? '') || current.cwd !== request.workspace) throw new Error('Cannot replace the frozen configuration of an active durable execution');
      } else await conversation.configure({ model, instructions: request.systemPrompt ?? '', cwd: request.workspace, tools: [], extensions: [],
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}) }, BACKGROUND_CONTEXT);
      let messages: unknown[] = [...(await conversation.context(BACKGROUND_CONTEXT)).messages];
      let closed = false;
      const inspect = (): AgentSessionInspect => ({ binding: request.binding, sessionId: String(conversation.id), sessionFile: `durable:${conversation.id}`,
        model: request.model.id, messages, leafId: null, bundleDigest: request.bundleDigest, toolPolicyDigest: request.toolPolicyDigest,
        runtimePolicyDigest: request.runtimePolicyDigest, piVersion: '1.1.0', activeTools: [], registeredTools: [], loadedExtensions: [] });
      const checked = () => { if (closed) throw new Error('Durable agent session is closed'); };
      return {
        inspect,
        async prompt(text, images) {
          checked();
          if (images?.length) throw new Error('Durable image bridge is not installed');
          const events = await watchEvents(host.harness, conversation.id, BACKGROUND_CONTEXT);
          events.start(async batch => {
            for (const event of batch) {
              if (event.type === 'message_start') request.onEvent?.({ type: 'message_start', message: event.message });
              if (event.type === 'message_end') for (const message of event.entry.model ?? []) request.onEvent?.({ type: 'message_end', message });
            }
          });
          try {
            const input = await conversation.submit({ type: 'input', content: text, requestId: request.executionId ?? randomUUID(), whenBusy: 'reject' }, BACKGROUND_CONTEXT);
            const result = await input.wait(BACKGROUND_CONTEXT);
            messages = [...(await conversation.context(BACKGROUND_CONTEXT)).messages];
            const last = [...messages].reverse().find(message => typeof message === 'object' && message !== null && 'role' in message && message.role === 'assistant');
            const assistantText = last && typeof last === 'object' && 'content' in last && Array.isArray(last.content)
              ? last.content.filter(part => part.type === 'text').map(part => part.text).join('') : '';
            return { inspect: inspect(), finalAssistantText: assistantText, stopReason: result.status === 'done' ? 'stop' : 'error',
              ...(result.status === 'done' ? {} : { errorMessage: String(result.detail ?? result.reason) }), usage: lastTurnUsage(inspect()) };
          } finally { await events.stop(); }
        },
        async compact(instructions) { checked(); const task = await conversation.compact(instructions, BACKGROUND_CONTEXT); await host.harness.waitForTask(task, BACKGROUND_CONTEXT); messages = [...(await conversation.context(BACKGROUND_CONTEXT)).messages]; },
        async steer(text) { checked(); await conversation.submit({ type: 'input', content: text, whenBusy: 'steer' }, BACKGROUND_CONTEXT); },
        async interrupt(text) { checked(); await conversation.abort(BACKGROUND_CONTEXT); if (text) await conversation.submit({ type: 'input', content: text }, BACKGROUND_CONTEXT); },
        async stop() { checked(); await conversation.abort(BACKGROUND_CONTEXT); },
        async close() { closed = true; },
      };
    },
  };
}
