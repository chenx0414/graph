import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';

const [root, baseUrl] = process.argv.slice(2) as [string, string];
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
      const session = await transport.open(request);
      return { ...session, prompt: async (text, images) => {
        await session.prompt(text, images);
        // The real SDK input and provider usage have settled; Graph has not
        // received the adapter result. This is the durable ACK crash boundary.
        process.send?.(created);
        return new Promise(() => {});
      } };
    } };
  },
});
created = await runtime.conversations.create({ text: 'Preserve my completed answer exactly once.', requestId: 'original-completed' });
await runtime.host.runReady();
throw new Error('The terminal receipt crash fixture must be killed before Graph receives its result');
