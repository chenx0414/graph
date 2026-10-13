import { join } from 'node:path';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';

const [root, baseUrl] = process.argv.slice(2) as [string, string];
process.on('message', () => {});
const agentContext = openAgentContextLibrary(join(root, 'prompts'));
await agentContext.ensure();
const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'), agentContext, access: () => fullAccessPolicy(),
  catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
  models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key' },
  master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
});
const created = await runtime.conversations.create({ text: 'Remember our original conversation.', requestId: 'initial' });
await runtime.host.runReady();
const baseline = await runtime.conversations.view(created.conversationId);
await runtime.conversations.chat(created.conversationId, { text: 'Perform the assigned effect once and preserve evidence if interrupted.', requestId: 'effect' });
process.send?.({ ...created, used: baseline.master?.used, workspace: join(root, 'state', 'conversations', created.conversationId) });
await runtime.host.runReady();
throw new Error('Crash fixture completed before the parent terminated the tool');
