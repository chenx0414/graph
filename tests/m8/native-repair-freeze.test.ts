import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy, standardAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/** Frozen task/recipe survive a real missing-output repair; the next execution adopts the patch. */
test('a durable node freezes its task and recipe across resubmission, then adopts the next revision', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-native-repair-freeze-'));
  for (const directory of ['original', 'next']) await mkdir(join(root, directory));
  await writeFile(join(root, 'original', 'identity.txt'), 'ORIGINAL_DIRECTORY');
  await writeFile(join(root, 'next', 'identity.txt'), 'NEXT_DIRECTORY');
  const outside = join(root, 'host.txt'); await writeFile(outside, 'OUTSIDE_CURRENT_DIRECTORY');
  const reads = (id: string) => ({ tools: [
    { id: `${id}-cwd`, name: 'read', arguments: JSON.stringify({ path: 'identity.txt' }) },
    { id: `${id}-outside`, name: 'read', arguments: JSON.stringify({ path: outside }) },
  ] });
  let hostAccess = fullAccessPolicy();
  const outsideRoot = await mkdtemp(join(tmpdir(), 'graph-workspace-outside-'));
  await symlink(outsideRoot, join(root, 'escape'));
  let patchDuringReply: () => Promise<void> = async () => {};
  const submit = (id: string, text: string) => ({ tools: [{ id, name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { text } } } }) }] });
  const provider = await openaiServer([
    { ...reads('original'), beforeReply: () => patchDuringReply() },
    { text: 'Work described, but the required output was not submitted.' },
    submit('repair', 'work done'), { text: 'Original execution finished.' },
    reads('next'),
    submit('next', 'new configuration'), { text: 'Next execution finished.' },
  ]);
  const runtime = await openTaskRuntime({ sessionTransport: createDurableSessionTransport, stateDir: join(root, 'state'), projects: [{ id: 'p', root }],
    access: () => hostAccess,
    limits: { defaultBudgetTokens: 20_000_000 },
    models: { entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }], apiKey: 'local-only', modelRuntime: provider.runtime },
  });
  try {
    runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium', systemPrompt: 'Original worker identity' }, 'worker-first');
    runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium', systemPrompt: 'Replacement worker identity' }, 'worker-next');
    const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'do it', requestId: 'begin' });
    const main = runtime.supervisor(taskId);
    const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Frozen repair',
      protocols: { out: { type: 'object', required: ['text'], properties: { text: { type: 'string' } } } },
      nodes: { work: { recipe: 'worker@1', model: 'local', task: 'ORIGINAL_TASK', instructions: 'Read planner plan artifact. Use tdd for construction.\n' + 'Complete every acceptance item. '.repeat(30) + 'FULL_INSTRUCTION_END', inputs: { job: { protocol: 'out' } },
        workspace: { base: 'project', path: 'original' }, access: { mode: 'standard' },
        outputs: { out: { protocol: 'out' } }, submission: { required: ['out'] } } }, modules: {}, edges: {},
      outputs: { result: { from: 'work.out', protocol: 'out' } },
    }) }) as { graphId: string };
    patchDuringReply = async () => {
      await main.graphPatch({ graphId, baseRevision: 1, changes: { reason: 'Apply replacement only to the next execution',
        patch: { nodes: { work: { task: 'REPLACEMENT_TASK', instructions: 'Read revised planner plan. Use diagnosing-bugs for the requested repair.', recipe: 'worker@2', workspace: { base: 'project', path: 'next' }, access: { mode: 'full' } } } } } });
    };
    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { text: 'go' } });
    await runtime.host.drive();
    expect(provider.requests).toHaveLength(4);
    const messages = (index: number) => (provider.requests[index] as { messages: { role: string; content: unknown }[] }).messages;
    const identity = (index: number) => messages(index).find(message => ['system', 'developer'].includes(message.role))?.content;
    expect(identity(0)).toContain('Original worker identity');
    expect(identity(1)).toBe(identity(0));
    expect(JSON.stringify(messages(0).at(-1))).toContain('ORIGINAL_TASK');
    expect(JSON.stringify(messages(0).at(-1))).toContain('Read planner plan artifact. Use tdd for construction.');
    expect(JSON.stringify(messages(0).at(-1))).toContain('FULL_INSTRUCTION_END');
    expect(JSON.stringify(messages(0).at(-1))).toContain('GRAPH OVERVIEW');
    expect(JSON.stringify(messages(0).at(-1))).toContain('go');
    expect(JSON.stringify(messages(1))).toContain('ORIGINAL_DIRECTORY');
    expect(JSON.stringify(messages(1))).not.toContain('OUTSIDE_CURRENT_DIRECTORY');
    expect(JSON.stringify(messages(2).at(-1))).toContain('required output(s) out');
    expect(JSON.stringify(messages(1).at(-1))).not.toContain('GRAPH OVERVIEW');
    expect(JSON.stringify(messages(1))).not.toContain('REPLACEMENT_TASK');
    expect(JSON.stringify(messages(2))).not.toContain('Read revised planner plan.');
    expect(runtime.nodePrompt(graphId, 'work')).toMatchObject({ configurations: {
      current: { revision: 1, definition: { instructions: expect.stringContaining('FULL_INSTRUCTION_END') } },
      next: { revision: 2, definition: { instructions: 'Read revised planner plan. Use diagnosing-bugs for the requested repair.' } }, pending: true,
    }, briefing: { text: expect.stringContaining('FULL_INSTRUCTION_END') } });
    const before = runtime.nodeRun(graphId, 'work');
    expect(before.operations).toMatchObject([{ state: 'completed', resubmits_used: 1, retries_used: 0 }]);
    expect(await main.graphInspect({ graphId, query: 'results' })).toMatchObject([{ value: { text: 'work done' } }]);
    expect(before.instance!.used).toBe(200);
    expect(before).toMatchObject({ toolCallCount: 3, environment: { workspace: join(root, 'original'), access: { mode: 'standard' }, revision: 1 } });

    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { text: 'next' } });
    await runtime.host.drive();
    expect(provider.requests, JSON.stringify(await main.graphInspect({ graphId, query: 'queue' }))).toHaveLength(7);
    expect(identity(4)).toContain('Replacement worker identity');
    expect(JSON.stringify(messages(4))).toContain('REPLACEMENT_TASK');
    expect(JSON.stringify(messages(4).at(-1))).toContain('Read revised planner plan. Use diagnosing-bugs for the requested repair.');
    expect(runtime.nodePrompt(graphId, 'work')).toMatchObject({ configurations: { current: { revision: 2 }, next: { revision: 2 }, pending: false },
      briefing: { text: expect.stringContaining('FULL_INSTRUCTION_END') } });
    const after = runtime.nodeRun(graphId, 'work');
    expect(after.session?.sessionId).toBe(before.session?.sessionId);
    expect(after.session?.sessionFile).toMatch(/^durable:/);
    expect(after.instance).toMatchObject({ id: before.instance!.id, used: 350, definitionVersion: 'worker@2' });
    expect(JSON.stringify(messages(5))).toContain('NEXT_DIRECTORY');
    expect(JSON.stringify(messages(5))).toContain('OUTSIDE_CURRENT_DIRECTORY');
    expect(after).toMatchObject({ toolCallCount: 6, environment: { workspace: join(root, 'next'), access: { mode: 'full' }, revision: 2 } });
    expect(after.operations).toHaveLength(2);
    expect(after.operations[1]).toMatchObject({ state: 'completed', resubmits_used: 0 });
    expect(await main.graphInspect({ graphId, query: 'results' })).toMatchObject([{ value: { text: 'work done' } }, { value: { text: 'new configuration' } }]);
    expect(JSON.stringify(messages(5))).toContain('ORIGINAL_DIRECTORY');
    expect(runtime.events(graphId).filter(event => event.type === 'graph.node.rebound')).toMatchObject([
      { data: { nodeId: 'work', revision: 2, previousWorkspace: join(root, 'original'), workspace: join(root, 'next') } },
    ]);
    const base = parseGraphDefinition(await main.graphInspect({ graphId, query: 'revision' }));
    const cases = [
      { workspace: { base: 'project', path: 'next' }, access: { mode: 'full' }, message: 'exceeds the host authorization' },
      { workspace: { base: 'project', path: 'missing' }, access: { mode: 'standard' }, message: 'workspace cannot be opened' },
      { workspace: { base: 'project', path: 'escape' }, access: { mode: 'standard' }, message: 'escapes its declared base' },
      { workspace: { base: 'worktree' }, access: { mode: 'standard' }, message: 'prepare this graph with a targetBranch' },
    ];
    hostAccess = standardAccessPolicy();
    for (const item of cases) {
      const definition = parseGraphDefinition({ ...base, nodes: { ...base.nodes, work: { ...base.nodes.work, workspace: item.workspace, access: item.access } } });
      const refused = await main.graphCreate({ definition }) as { graphId: string };
      await main.graphSend({ graphId: refused.graphId, nodeId: 'work', input: 'job', value: { text: 'retained' } });
      await runtime.host.drive();
      expect(provider.requests).toHaveLength(7);
      const failedQueue = await main.graphInspect({ graphId: refused.graphId, query: 'queue' });
      expect(failedQueue).toMatchObject({ items: [{ state: 'queued', payload: { value: { text: 'retained' } } }] });
      expect(runtime.events(refused.graphId).filter(event => event.type === 'graph.node.blocked')).toMatchObject([
        { data: { nodeId: 'work', reason: expect.stringContaining(item.message) } },
      ]);
      const failedRun = runtime.nodeRun(refused.graphId, 'work');
      expect(failedRun.operations).toMatchObject([{ state: 'blocked', retries_used: 0 }]);
      expect(failedRun.instance).toMatchObject({ reserved: 0, used: 0 });
    }
  } finally {
    await runtime.close(); await provider.close(); await rm(root, { recursive: true, force: true }); await rm(outsideRoot, { recursive: true, force: true });
  }
}, 60_000);
