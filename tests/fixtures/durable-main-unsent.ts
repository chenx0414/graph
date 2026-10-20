import { setTimeout } from 'node:timers/promises';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { createModelScheduler } from '../../src/runtime/model-scheduler.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';

const [root, baseUrl] = process.argv.slice(2) as [string, string];
process.on('message', () => {});
const agentContext = openAgentContextLibrary(join(root, 'prompts'));
await agentContext.ensure();
await agentContext.savePrompt('agents/main.md', 'ORIGINAL_FROZEN_MAIN_IDENTITY. Answer the user request.');
const extension = join(root, 'capabilities', 'policy-proof');
await mkdir(extension, { recursive: true });
await writeFile(join(extension, 'capability.json'), JSON.stringify({ id: 'policy-proof', kind: 'extension', version: '1.0.0', name: 'Frozen policy proof', entry: './index.mjs' }));
await writeFile(join(extension, 'index.mjs'), `
  import {writeFileSync} from 'node:fs';
  export function register(api) {
    api.tool({name:'write_frozen',description:'Exercise the original frozen execution rights',parameters:{type:'object',properties:{outside:{type:'string'}},required:['outside']},
      execute:args=>{writeFileSync(args.outside,'ORIGINAL_RESOURCE_BYTES');return 'Original archived extension wrote with its original rights';}});
  }
`);

const scheduler = createModelScheduler();
// A real credential slot parks SDK generation before Graph's provider dispatch.
await scheduler.acquire({ credentialId: 'original-binding', apiKey: 'old-key', limit: 1 });
const runtime = await openTaskRuntime({
  stateDir: join(root, 'state'), agentContext, access: () => fullAccessPolicy(),
  catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
  models: {
    entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'original-binding' }],
    credentialFor: () => ({ credentialId: 'original-binding', apiKey: 'old-key', limit: 1 }), modelScheduler: scheduler,
  },
  master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
});
runtime.catalog.publishDefinition('master', { recommendedGrade: 'high', capabilities: [{ id: 'policy-proof', version: '1.0.0' }] }, 'master');
const first = await runtime.conversations.create({ text: 'First original admitted request.', requestId: 'first-original' });
const second = await runtime.conversations.create({ text: 'Second original admitted request.', requestId: 'second-original' });
void runtime.host.runReady().catch(error => { process.send?.({ error: String(error) }); });
while (scheduler.queued() < 2) await setTimeout(20);
process.send?.({ first, second });
await new Promise(() => {});
