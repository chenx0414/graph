import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from '../../src/git/git.ts';
import type { Receipt } from '../../src/core/types.ts';

// Native host wiring must preserve the same finite/unlimited evidence policy as
// the existing model adapter; the provider deliberately supplies no token counts.
test('native unlimited turns estimate absent usage while finite turns retain an unknown hold', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-missing-usage-'));
  const plans = (path: string) => [
    { usage: null, tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path, content: 'actual tool output' }) }] },
    { usage: null, text: 'Finished after the file tool.' },
  ];
  const unlimited = await openaiServer(plans('unlimited.txt'));
  const finite = await openaiServer(plans('finite.txt'));
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
    runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy(),
      catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
      models: { apiKey: 'local-only', modelRuntime: unlimited.runtime, entries: [
        ...([['unlimited', unlimited], ['finite', finite]] as const).map(([id, provider]) => ({ id, provider: provider.model.provider,
          grade: 'medium' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 })),
      ] },
    });
    runtime.catalog.publishDefinition('writer', { recommendedGrade: 'medium' }, 'writer');
    const parent = await runtime.user.begin({ projectId: 'p', request: 'missing usage policy', requestId: 'begin' });
    const main = runtime.supervisor(parent.taskId);
    const node = (model: string, tokens: number | null) => ({ recipe: 'writer@1', model, task: 'Write a file and report completion.',
      inputs: { job: { protocol: 'data' } }, outputs: {}, submission: {}, budget: { tokens } });
    const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'missing usage', protocols: { data: { type: 'object' } },
      nodes: { unlimited: node('unlimited', null), finite: node('finite', 200000) }, modules: {}, edges: {} }) }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'unlimited', input: 'job', value: {} });
    await main.graphSend({ graphId, nodeId: 'finite', input: 'job', value: {} });
    await runtime.host.drive();
    expect(unlimited.requests).toHaveLength(2);
    expect(runtime.nodeRun(graphId, 'unlimited').node.status).toBe('succeeded');
    expect(await readFile(join(root, 'unlimited.txt'), 'utf8')).toBe('actual tool output');
    const calls = await main.graphInspect({ graphId, query: 'provider_calls' }) as { nodeId: string; state: string; usage: { usageSource: string; input: number; output: number } | null }[];
    const estimated = calls.filter(call => call.nodeId === 'unlimited');
    expect(estimated).toHaveLength(2);
    for (const call of estimated) {
      expect(call.state).toBe('settled'); expect(call.usage?.usageSource).toBe('estimated');
      expect(call.usage!.input).toBeGreaterThan(0); expect(call.usage!.output).toBeGreaterThan(0);
    }
    expect(finite.requests).toHaveLength(1);
    expect(calls.filter(call => call.nodeId === 'finite')).toMatchObject([{ state: 'unknown', usage: null }]);
    const failed = await main.graphInspect({ graphId, query: 'queue' }) as { items: { nodeId: string; state: string }[] };
    expect(failed.items.find(item => item.nodeId === 'finite')?.state).toBe('queued');
    expect(runtime.nodeRun(graphId, 'finite').node.status).toBe('blocked');
  } finally {
    await runtime?.close(); await finite.close(); await unlimited.close(); await rm(root, { recursive: true, force: true });
  }
}, 30000);


test('unestimatable unlimited usage permits the frozen turn and Git commit, but holds the next finite execution', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'graph-native-unknown-usage-'));
  const root = join(parent, 'project'); await mkdir(root);
  const checkedGit = (args: string[]) => { const result = git(root, args); if (result.code) throw new Error(result.stderr); return result.stdout.trim(); };
  checkedGit(['init', '-b', 'main']); checkedGit(['config', 'user.name', 'Graph Test']); checkedGit(['config', 'user.email', 'graph-test@example.invalid']);
  await writeFile(join(root, 'seed.txt'), 'baseline'); checkedGit(['add', 'seed.txt']); checkedGit(['commit', '-m', 'Baseline']);
  let release!: () => void; let received!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { received = resolve; });
  const provider = await openaiServer([
    // Large transport evidence exceeds the estimator's bounded reader. The valid
    // SSE comment does not inflate the model transcript or invent a usage receipt.
    { usage: null, comments: ['x'.repeat(8_000_001)], beforeReply: async () => { received(); await waiting; },
      tools: [{ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'result.txt', content: 'Work with unknown usage' }) }] },
    { tools: [{ id: 'commit', name: 'workspace_commit', arguments: JSON.stringify({ paths: ['result.txt'], message: 'Publish actual work' }) }] },
    { text: 'Committed the work.' },
  ]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(parent, 'capabilities'); await mkdir(capabilityRoot);
    runtime = await openTaskRuntime({ stateDir: join(parent, 'state'), projects: [{ id: 'p', root }], access: () => fullAccessPolicy(),
      catalog: { capabilityRoot, recipesPath: join(parent, 'recipes.json') },
      models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider,
        grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
    });
    runtime.catalog.publishDefinition('writer', { recommendedGrade: 'medium' }, 'writer');
    const owner = await runtime.user.begin({ projectId: 'p', request: 'Unknown unlimited usage', requestId: 'begin' });
    const main = runtime.supervisor(owner.taskId);
    const { graphId } = await main.graphCreate({ targetBranch: 'main', definition: parseGraphDefinition({ schemaVersion: 2, name: 'unknown usage', protocols: { job: { type: 'object' } },
      nodes: { work: { recipe: 'writer@1', model: 'local', task: 'Write result.txt, commit it and report.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {}, budget: { tokens: null } } },
      modules: {}, edges: {} }) }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
    const drive = runtime.host.drive();
    try {
      await arrived;
      await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Finite budget for the next execution', patch: { nodes: { work: { budget: { tokens: 500000 } } } } } });
    } finally { release(); await drive; }
    expect(provider.requests).toHaveLength(3);
    const commitReply = (provider.requests[2] as { messages: { role: string; tool_call_id?: string; content: string }[] }).messages
      .find(message => message.role === 'tool' && message.tool_call_id === 'commit');
    expect(commitReply).toBeDefined();
    const toolResult = JSON.parse(commitReply!.content) as { content: { type: string; text: string }[] };
    const committed = JSON.parse(toolResult.content.find(part => part.type === 'text')!.text) as { commit: string };
    expect(committed).toMatchObject({ commit: expect.stringMatching(/^[0-9a-f]{40}$/) });
    expect(checkedGit(['show', `${committed.commit}:result.txt`])).toBe('Work with unknown usage');
    const run = runtime.nodeRun(graphId, 'work');
    expect(run.node.status).toBe('succeeded');
    expect(run.invocations.filter(call => call.usageSource === 'unknown')).toMatchObject([{ usage: null, usageSource: 'unknown', cost: null }]);
    const firstExecutions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { attempt: number; tokenBudget: { budget: number; unlimited: boolean } }[] };
    expect(firstExecutions.items[0]!.tokenBudget).toEqual({ budget: 0, unlimited: true });
    const view = await runtime.user.task(graphId).view();
    expect(view.integrationSha).toBeTruthy();
    expect(checkedGit(['show', `${view.integrationSha}:result.txt`])).toBe('Work with unknown usage');
    await runtime.sendNodeMessage(graphId, 'work', { text: 'A finite follow-up.', requestId: 'finite-next' });
    await runtime.host.drive();
    expect(provider.requests).toHaveLength(3);
    const next = runtime.nodeRun(graphId, 'work');
    expect(next.node.status).toBe('blocked');
    const nextExecutions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { attempt: number; tokenBudget: { budget: number; unlimited: boolean } }[] };
    expect(nextExecutions.items.at(-1)).toMatchObject({ attempt: 0, tokenBudget: { budget: 500000, unlimited: false } });
    expect(next.invocations.filter(call => 'state' in call).find(call => call.state === 'unknown')!.reserved).toBeGreaterThan(0);
    expect(runtime.events(graphId).filter(event => event.type === 'graph.node.blocked').at(-1)!.data)
      .toMatchObject({ reason: expect.stringMatching(/Unknown provider usage must be reconciled/) });
    expect(next.invocations.filter(call => call.usageSource === 'unknown')).toHaveLength(1);
  } finally { release(); await runtime?.close(); await provider.close(); await rm(parent, { recursive: true, force: true }); }
}, 30000);

// The user policy entry point must not depend on legacy instances. This actual
// provider contract owns authorization, frozen turns and durable policy together.
test('user quota changes persist for native nodes without changing an active turn or its usage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-user-quota-'));
  let release!: () => void; let received!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const arrived = new Promise<void>(resolve => { received = resolve; });
  const provider = await openaiServer([
    { text: 'First reply.', beforeReply: async () => { received(); await waiting; } },
    { text: 'Second reply.' }, { text: 'Unlimited reply.' },
  ]);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
    const options: Parameters<typeof openTaskRuntime>[0] = { stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
      access: () => fullAccessPolicy(), limits: { defaultBudgetTokens: 200000 },
      catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
      models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider,
        grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
    };
    runtime = await openTaskRuntime(options);
    runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'worker');
    const owner = await runtime.user.begin({ projectId: 'p', request: 'User quota', requestId: 'begin' });
    const { graphId } = await runtime.supervisor(owner.taskId).graphCreate({ definition: parseGraphDefinition({
      schemaVersion: 2, name: 'user quota', protocols: { job: { type: 'object' } },
      nodes: { work: { recipe: 'worker@1', model: 'local', task: 'Reply to this message.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} } },
      modules: {}, edges: {},
    }) }) as { graphId: string };
    await runtime.supervisor(owner.taskId).graphSend({ graphId, nodeId: 'work', input: 'job', value: {} });
    const drive = runtime.host.drive();
    let grant: Receipt | undefined;
    try {
      await arrived;
      await expect(runtime.supervisor(graphId).controlTask({ action: 'set_budget', nodeId: 'work', tokens: null, requestId: 'main-cannot-grant' })).rejects.toThrow(/graph_patch/);
      grant = await runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: 400000, requestId: 'grant' });
      expect(await runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: 400000, requestId: 'grant' })).toEqual(grant);
      await expect(runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: null, requestId: 'grant' })).rejects.toThrow(/different|conflict/i);
    } finally { release(); await drive; }
    const first = runtime.nodeRun(graphId, 'work');
    expect(first.instance).toMatchObject({ budget: 200000, unlimited: false, authorizedBudget: { budget: 400000, unlimited: false } });
    const used = first.instance!.used;
    expect(used).toBeGreaterThan(0);
    await runtime.supervisor(owner.taskId).graphPatch({ graphId, baseRevision: 1, changes: {
      reason: 'Use the new user quota', patch: { nodes: { work: { budget: { tokens: 400000 } } } },
    } });
    await runtime.sendNodeMessage(graphId, 'work', { text: 'Second message.', requestId: 'second' });
    await runtime.host.drive();
    expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ budget: 400000, unlimited: false });
    await runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: null, requestId: 'unlimited' });
    await runtime.supervisor(owner.taskId).graphPatch({ graphId, baseRevision: 2, changes: {
      reason: 'Use explicit unlimited authorization', patch: { nodes: { work: { budget: null } } },
    } });
    await runtime.sendNodeMessage(graphId, 'work', { text: 'Unlimited message.', requestId: 'third' });
    await runtime.host.drive();
    const third = runtime.nodeRun(graphId, 'work');
    expect(third.instance).toMatchObject({ budget: null, unlimited: true, authorizedBudget: { budget: 0, unlimited: true } });
    expect(third.instance!.used).toBeGreaterThan(used);
    expect(provider.requests).toHaveLength(3);
    await runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: 10, requestId: 'reduce' });
    await expect(runtime.user.task(graphId).setBudget({ nodeId: 'ghost', tokens: 10, requestId: 'ghost' })).rejects.toThrow(/Unknown agent node/);
    await runtime.close(); runtime = await openTaskRuntime(options);
    expect(runtime.nodeRun(graphId, 'work').instance).toMatchObject({ used: third.instance!.used, authorizedBudget: { budget: 10, unlimited: false } });
    await runtime.supervisor(owner.taskId).graphPatch({ graphId, baseRevision: 3, changes: {
      reason: 'A graph declaration cannot increase authorization', patch: { nodes: { work: { budget: { tokens: 1000000 } } } },
    } });
    await runtime.sendNodeMessage(graphId, 'work', { text: 'Must remain within authorization.', requestId: 'fourth' });
    await runtime.host.drive();
    expect(provider.requests).toHaveLength(3);
    expect(runtime.nodeRun(graphId, 'work').node.status).toBe('blocked');
    expect(runtime.events(graphId).filter(event => event.type === 'graph.node.blocked').at(-1)!.data).toMatchObject({ reason: expect.stringMatching(/user-authorized quota/) });
    expect(runtime.nodeRun(graphId, 'work').invocations).toEqual(third.invocations);
    await runtime.supervisor(owner.taskId).graphControl({ graphId, action: 'stop' });
    await expect(runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: null, requestId: 'after-stop' })).rejects.toThrow(/Ended graph/);
    expect(await runtime.user.task(graphId).setBudget({ nodeId: 'work', tokens: 400000, requestId: 'grant' })).toEqual(grant!);
  } finally { release(); await runtime?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 30000);
