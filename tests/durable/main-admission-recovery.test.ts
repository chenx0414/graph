import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile, rm, readdir, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { standardAccessPolicy } from '../../src/core/access-policy.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

// A credential-slot wait is a real admitted durable generation, with no HTTP
// dispatch. Two conversations expose the shared scheduler's registration barrier.
test('hard-killed unsent main admissions keep their original configuration and input while resolving rotated credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-unsent-'));
  const plans: ResponsePlan[] = Array.from({ length: 4 }, () => ({}));
  const original = await openaiServer(plans);
  for (const plan of plans) plan.beforeReply = () => {
    const request: { messages: { role: string; content?: string }[] } = JSON.parse(JSON.stringify(original.requests.at(-1)));
    if (request.messages.some(message => message.role === 'tool')) plan.text = 'Recovered original request.';
    else plan.tools = [{ id: 'frozen-rights-tool', name: 'mcp_policy_proof_write_frozen', arguments: JSON.stringify({ outside: join(root, request.messages.some(message => message.content?.includes('First original')) ? 'first-outside.txt' : 'second-outside.txt') }) }];
  };
  const updated = await openaiServer([{ text: 'Reply under the new configuration.' }]);
  let child: ReturnType<typeof fork> | undefined;
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    child = fork(fileURLToPath(new URL('../fixtures/durable-main-unsent.ts', import.meta.url)), [root, original.model.baseUrl], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', data => { stderr += data; });
    const admitted = await new Promise<{ first: { conversationId: string; taskId: string }; second: { conversationId: string; taskId: string } }>((resolve, reject) => {
      child!.once('message', message => {
        const decoded: { error?: string; first: { conversationId: string; taskId: string }; second: { conversationId: string; taskId: string } } = JSON.parse(JSON.stringify(message));
        if (decoded.error) reject(new Error(decoded.error));
        else resolve(decoded);
      });
      child!.once('error', reject);
      child!.once('exit', code => reject(new Error(`Unsent fixture exited ${code}: ${stderr}`)));
    });
    expect(original.requests).toHaveLength(0);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    const agentContext = openAgentContextLibrary(join(root, 'prompts'));
    await agentContext.savePrompt('agents/main.md', 'UPDATED_MAIN_IDENTITY. Use the new settings.');
    await writeFile(join(root, 'capabilities', 'policy-proof', 'index.mjs'), `export function register(api) { api.tool({name:'write_frozen',description:'Updated live tool',parameters:{type:'object',properties:{outside:{type:'string'}},required:['outside']},execute:()=>{throw new Error('LATEST_RESOURCE_BYTES must not run');}}); }`);
    const recoveryOptions: Parameters<typeof openTaskRuntime>[0] = {
      stateDir: join(root, 'state'), agentContext, access: () => standardAccessPolicy(),
      catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
      models: {
        entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: updated.model.baseUrl, contextWindow: 16_000, maxTokens: 512, credentialId: 'original-binding' }],
        credentialFor: () => ({ credentialId: 'original-binding', apiKey: 'rotated-key', limit: 1 }), modelRuntime: updated.runtime,
      },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    };
    const instances = await readdir(join(root, 'state', 'instances'), { withFileTypes: true });
    let heldArchive: string | undefined;
    for (const instance of instances.filter(item => item.isDirectory())) {
      const directory = join(root, 'state', 'instances', instance.name, 'durable-frozen-resources');
      const files = await readdir(directory).catch((): string[] => []);
      const digest = files.find(name => /^[0-9a-f]{64}$/.test(name));
      if (digest) { heldArchive = join(directory, digest); break; }
    }
    if (!heldArchive) throw new Error('The admitted execution has no actual frozen resource archive');
    await rename(heldArchive, `${heldArchive}.held`);
    try { await expect(openTaskRuntime(recoveryOptions)).rejects.toThrow(/ENOENT|archive|resource/i); }
    finally { await rename(`${heldArchive}.held`, heldArchive); }
    expect(original.requests).toHaveLength(0);
    // Repairing the resource must let the same process reopen: failed startup
    // must have released both its durable worker and database ownership lock.
    runtime = await openTaskRuntime(recoveryOptions);
    await runtime.host.runReady();
    for (const created of [admitted.first, admitted.second]) {
      const view = await runtime.conversations.view(created.conversationId);
      expect(view.messages.filter(message => message.role === 'user')).toHaveLength(1);
      expect(view.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Recovered original request.');
      expect(view.questions.filter(question => question.status === 'open')).toEqual([]);
      expect(view.master?.used).toBeGreaterThan(0);
    }
    expect(await readFile(join(root, 'first-outside.txt'), 'utf8')).toBe('ORIGINAL_RESOURCE_BYTES');
    expect(await readFile(join(root, 'second-outside.txt'), 'utf8')).toBe('ORIGINAL_RESOURCE_BYTES');
    expect(original.requests).toHaveLength(4);
    const firstCalls = original.requests.filter(request => { const value: { messages: { role: string }[] } = JSON.parse(JSON.stringify(request)); return !value.messages.some(message => message.role === 'tool'); });
    expect(firstCalls.map(request => JSON.stringify(request)).filter(request => request.includes('First original admitted request.'))).toHaveLength(1);
    expect(firstCalls.map(request => JSON.stringify(request)).filter(request => request.includes('Second original admitted request.'))).toHaveLength(1);
    expect(original.authorizations).toEqual(Array(4).fill('Bearer rotated-key'));
    for (const request of original.requests) {
      expect(JSON.stringify(request)).toContain('ORIGINAL_FROZEN_MAIN_IDENTITY');
      expect(JSON.stringify(request)).not.toContain('UPDATED_MAIN_IDENTITY');
    }
    expect(updated.requests).toHaveLength(0);
    await runtime.conversations.chat(admitted.first.conversationId, { text: 'Now continue with the new configuration.', requestId: 'new-configuration' });
    await runtime.host.runReady();
    expect(updated.requests).toHaveLength(1);
    expect(JSON.stringify(updated.requests[0])).toContain('UPDATED_MAIN_IDENTITY');
    expect(original.requests).toHaveLength(4);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await runtime?.close();
    await original.close();
    await updated.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);

// Different failure boundary: the provider and SDK succeeded but the Graph
// result was never acknowledged. Recovery must settle rather than call again.
test.each([false, true])('a completed durable main receipt survives death before Graph acknowledgement without another provider call (steering=%s)', async steering => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-before-ack-'));
  const provider = await openaiServer([...(steering ? [{ tools: [{ id: 'wait-for-clarification', name: 'bash', arguments: JSON.stringify({ command: 'sleep 5' }) }] }] : []), { text: 'Already completed before the crash.' }]);
  let child: ReturnType<typeof fork> | undefined;
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    child = fork(fileURLToPath(new URL('../fixtures/durable-main-before-ack.ts', import.meta.url)), [root, provider.model.baseUrl, ...(steering ? ['steer'] : [])], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', data => { stderr += data; });
    const completed = await new Promise<{ conversationId: string; taskId: string }>((resolve, reject) => {
      child!.on('message', message => { const value = JSON.parse(JSON.stringify(message)); if (value.error) reject(new Error(value.error)); else if (value.stage === 'steer-ready') child!.send('steer'); else if (value.stage === 'completed') resolve(value); });
      child!.once('error', reject);
      child!.once('exit', code => reject(new Error(`Terminal fixture exited ${code}: ${stderr}`)));
    });
    expect(provider.requests).toHaveLength(steering ? 2 : 1);
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    for (const instance of await readdir(join(root, 'state', 'instances'))) await rm(join(root, 'state', 'instances', instance, 'durable-frozen-resources'), { recursive: true, force: true });
    const options = {
      stateDir: join(root, 'state'), agentContext: openAgentContextLibrary(join(root, 'prompts')),
      catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
      // Completed work must remain readable even after its credential and model
      // connection are removed from the current settings.
      models: { entries: [], modelRuntime: provider.runtime },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    };
    runtime = await openTaskRuntime(options);
    await runtime.host.runReady();
    const recovered = await runtime.conversations.view(completed.conversationId);
    expect(recovered.messages.filter(message => message.role === 'user')).toHaveLength(steering ? 2 : 1);
    expect(recovered.messages.filter(message => message.role === 'assistant').map(message => message.text)).toEqual(['Already completed before the crash.']);
    expect(recovered.questions.filter(question => question.status === 'open')).toEqual([]);
    expect(recovered.master?.used).toBeGreaterThan(0);
    expect(provider.requests).toHaveLength(steering ? 2 : 1);
    await runtime.close();
    runtime = await openTaskRuntime(options);
    await runtime.host.runReady();
    const repeated = await runtime.conversations.view(completed.conversationId);
    expect(repeated.messages.map(message => message.id)).toEqual(recovered.messages.map(message => message.id));
    expect(repeated.master?.used).toBe(recovered.master?.used);
    expect(provider.requests).toHaveLength(steering ? 2 : 1);
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await runtime?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
