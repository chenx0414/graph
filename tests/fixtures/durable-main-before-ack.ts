import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';

const [root, baseUrl, mode] = process.argv.slice(2) as [string, string, string | undefined];
process.on('message', () => {});
const agentContext = openAgentContextLibrary(join(root, 'prompts'));
await agentContext.ensure();
let created: { conversationId: string; taskId: string };
const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'), agentContext, access: () => fullAccessPolicy(),
  catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
  models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'old-key' },
  master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  sessionTransport: async store => {
    const transport = await createDurableSessionTransport(store);
    return { ...transport, open: async request => {
      const session = await transport.open({ ...request, onEvent: event => { request.onEvent?.(event); if (mode === 'steer' && event.type === 'tool_execution_start' && event.toolName === 'bash') process.send?.({ stage: 'steer-ready', ...created }); } });
      return { ...session, prompt: async (text, images) => {
        await session.prompt(text, images);
        // The real SDK input and provider usage have settled; Graph has not
        // received the adapter result. This is the durable ACK crash boundary.
        process.send?.({ stage: 'completed', ...created });
        return new Promise(() => {});
      } };
    } };
  },
});
created = await runtime.conversations.create({ text: 'Preserve my completed answer exactly once.', requestId: 'original-completed' });
process.on('message', message => { if (message === 'steer') void (async () => { await runtime.conversations.chat(created.conversationId, { text: 'Latest clarification before the crash.', requestId: 'latest-clarification' }); await runtime.conversations.steer(created.conversationId, { requestId: 'crash-boundary-steering' }); })().catch(error => process.send?.({ error: String(error) })); });
await runtime.host.runReady();
throw new Error('The terminal receipt crash fixture must be killed before Graph receives its result');
