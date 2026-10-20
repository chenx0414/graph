import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// Owns the process-death contract absent from graceful close/reopen coverage.
// An actual shell effect and real HTTP response precede SIGKILL; no receipts
// or database execution facts are manufactured by the fixture.
test('hard killing main during an unsafe tool preserves its effect and a main-owned problem without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-kill-'));
  const provider = await openaiServer([{ text: 'Persisted baseline reply.' }, { tools: [{ id: 'unsafe-effect', name: 'bash', arguments: JSON.stringify({ command: "printf 'effect\n' >> effect.txt; sleep 30" }) }] }, { text: 'Continued after inspecting the interrupted effect.' }]);
  let child: ReturnType<typeof fork> | undefined;
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    child = fork(fileURLToPath(new URL('../fixtures/durable-main-crash.ts', import.meta.url)), [root, provider.model.baseUrl], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    let stderr = '';
    child.stderr!.on('data', data => { stderr += data; });
    const created = await new Promise<{ conversationId: string; taskId: string; workspace: string; used: number }>((resolve, reject) => {
      child!.once('message', resolve);
      child!.once('error', reject);
      child!.once('exit', code => reject(new Error(`Crash fixture exited ${code}: ${stderr}`)));
    });
    await expect.poll(async () => readFile(join(created.workspace, 'effect.txt'), 'utf8').catch(() => '')).toBe('effect\n');
    expect(provider.requests).toHaveLength(2);
    expect(created.used).toBeGreaterThan(0);
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
    runtime = await openTaskRuntime({
      stateDir: join(root, 'state'), agentContext: openAgentContextLibrary(join(root, 'prompts')), access: () => fullAccessPolicy(),
      catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    });
    const view = await runtime.conversations.view(created.conversationId);
    expect(view.messages.filter(message => message.role === 'user')).toHaveLength(2);
    expect(view.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Persisted baseline reply.');
    expect(view.master?.used).toBeGreaterThanOrEqual(created.used);
    await expect(runtime.supervisor(created.taskId).listProblems()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ nodeId: 'master', kind: 'recovery' })]));
    await runtime.host.runReady();
    expect(provider.requests).toHaveLength(2);
    expect(await readFile(join(created.workspace, 'effect.txt'), 'utf8')).toBe('effect\n');
    await runtime.conversations.chat(created.conversationId, { text: 'I inspected effect.txt. Preserve it and continue without repeating the shell command.', requestId: 'continue-after-inspection' });
    await runtime.host.runReady();
    const continued = await runtime.conversations.view(created.conversationId);
    expect(continued.questions.filter(question => question.status === 'open')).toEqual([]);
    expect(continued.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Continued after inspecting the interrupted effect.');
    expect(provider.requests).toHaveLength(3);
    expect(JSON.stringify(provider.requests[2])).toContain('Persisted baseline reply.');
    expect(await readFile(join(created.workspace, 'effect.txt'), 'utf8')).toBe('effect\n');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; }
    await runtime?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 40_000);
