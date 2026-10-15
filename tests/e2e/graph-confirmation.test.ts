import { afterEach, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore } from '../../src/core/store.ts';
import { KernelStore } from '../../src/core/kernel-store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { createApp } from '../../src/server/app.ts';
import type { NativeProposal } from '../../src/core/types.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const DEFINITION = parseGraphDefinition({
  schemaVersion: 2, name: 'chain',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: { recipe: 'a@1', task: 'a', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
    b: { recipe: 'b@1', task: 'b', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] } },
  },
  modules: {
    gate: { type: 'router', trigger: 'each', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, rules: [{ when: 'in.n > 0', emit: { out: '$in' } }] },
  },
  edges: { ab: { from: 'a.out', to: 'b.in', enabled: true } },
});

  test('W5: confirming a draft that carries a v2 definition creates a runnable v2 graph', async () => {
    const root = await mkdtemp(join(tmpdir(), 'confirm-graph-e2e-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const provider = await openaiServer([{ text: 'Draft ready' }, { text: 'The graph is ready; main must send its first input' },
      { tools: [{ id: 'a-submit', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 42 } } } }) }] },
      { text: 'a submitted' },
      { tools: [{ id: 'b-submit', name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 43 } } } }) }] },
      { text: 'b submitted' }]); cleanup.push(() => provider.close());
    const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') }, projects: [{ id: 'p', root: project }],
      limits: { defaultBudgetTokens: 20_000_000 }, models: { apiKey: 'local-only', modelRuntime: provider.runtime,
        entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' } });
    for (const id of ['master', 'a', 'b']) runtime.catalog.publishDefinition(id, { recommendedGrade: 'medium' }, id);
    cleanup.push(() => runtime.close());

    const created = await runtime.conversations.create({ text: '做一个两节点链', requestId: 'create' });
    await runtime.host.runReady();
    const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });

    // The draft carries a v2 definition and empty old-shaped nodes: the definition is
    // the graph, so nothing old-shaped is required.
    await runtime.supervisor(anchorTaskId).propose({
      requirementVersion: 1, summary: '两节点链',
      acceptance: [{ id: 'works', description: '链跑通', checkNode: 'b' }],
      definition: { ...DEFINITION, acceptance: [{ id: 'works', description: '链跑通', kind: 'human' }] },
    }, 'proposal-v2');

    const app = await createApp(runtime, { origin: 'http://127.0.0.1:1' });
    cleanup.push(() => app.close());
    const home = await app.inject({ method: 'GET', url: '/' });
    const headers = { cookie: String(home.headers['set-cookie'] ?? '') };
    const ownerGraphResponse = await app.inject({ method: 'GET', url: `/api/tasks/${anchorTaskId}/graph`, headers });
    expect(ownerGraphResponse.statusCode).toBe(200);
    expect(ownerGraphResponse.json()).toMatchObject({ nodes: [], containers: [], layout: { positions: {}, edges: [] } });

    const draftResponse = await app.inject({ method: 'GET', url: `/api/conversations/${created.conversationId}/draft-graph`, headers });
    expect(draftResponse.statusCode).toBe(200);
    const draft = draftResponse.json();
    expect(draft.nodes.map((node: { id: string }) => node.id)).toEqual(['a', 'b', 'gate']);
    expect(draft.nodes.find((node: { id: string }) => node.id === 'gate')).toMatchObject({ kind: 'module', status: 'draft', action: 'route' });
    expect(draft.layout.edges).toMatchObject([{ id: 'ab', source: 'a', target: 'b' }]);
    expect(draft.interfaces).toMatchObject([{ edgeId: 'ab', from: 'a.out', to: 'b.in', protocol: 'ping', latest: null, deliveries: [] }]);

    const confirmed = await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });

    const runningResponse = await app.inject({ method: 'GET', url: `/api/tasks/${confirmed.taskId}/graph`, headers });
    expect(runningResponse.statusCode).toBe(200);
    const running = runningResponse.json();
    expect(running.nodes.map((node: { id: string }) => node.id)).toEqual(['a', 'b', 'gate']);
    expect(running.nodes.every((node: { status: string }) => node.status === 'idle')).toBe(true);
    expect(running.layout).toEqual(draft.layout);
    expect(running.interfaces).toMatchObject([{ edgeId: 'ab', from: 'a.out', to: 'b.in', protocol: 'ping', latest: null, deliveries: [] }]);
    await expect(runtime.supervisor(confirmed.taskId).graphState()).resolves.toMatchObject({
      taskId: confirmed.taskId, graphVersion: 1, graph: { schemaVersion: 2 },
      nodes: expect.arrayContaining([expect.objectContaining({ id: 'a', status: 'idle', origin: 'v2' })]),
    });

    await runtime.host.drive();
    expect(JSON.stringify(provider.requests)).toContain(`Graph ${confirmed.taskId} is ready`);
    expect(JSON.stringify(provider.requests)).toContain('graph_send');
    // Replaying confirmation must not wake main twice.
    const count = provider.requests.length;
    await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' });
    await runtime.host.drive();
    expect(provider.requests).toHaveLength(count);

    await runtime.supervisor(anchorTaskId).graphSend({ graphId: confirmed.taskId, nodeId: 'a', input: 'in', value: { n: 0 } });
    await runtime.host.drive();
    await expect(runtime.supervisor(anchorTaskId).graphInspect({ graphId: confirmed.taskId, query: 'executions' })).resolves.toMatchObject({ items: expect.arrayContaining([
      expect.objectContaining({ nodeId: 'a', state: 'completed' }), expect.objectContaining({ nodeId: 'b', state: 'completed' }),
    ]) });
    await expect(runtime.supervisor(anchorTaskId).graphInspect({ graphId: confirmed.taskId, query: 'edge', id: 'ab' })).resolves.toMatchObject({ deliveries: [{ value: { n: 42 } }] });
    expect(provider.requests).toHaveLength(count + 4);

    // The feature task is a real v2 graph: revision 1, both nodes and the module admitted.
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    const kernel = new KernelStore(store);
    expect(kernel.latestRevision(confirmed.taskId)).toMatchObject({ version: 1 });
    const nodes = store.db.prepare('SELECT node_id FROM kernel_nodes WHERE task_id=? ORDER BY node_id').all(confirmed.taskId) as { node_id: string }[];
    expect(nodes.map(n => n.node_id)).toEqual(['a', 'b']);
    const modules = store.db.prepare('SELECT module_id FROM kernel_modules WHERE task_id=?').all(confirmed.taskId) as { module_id: string }[];
    expect(modules.map(m => m.module_id)).toEqual(['gate']);
    // Nothing old-shaped was written for this task: it is on the new kernel, not both.
    const oldRevisions = store.db.prepare('SELECT COUNT(*) AS n FROM graph_revisions WHERE task_id=?').get(confirmed.taskId) as { n: number };
    expect(oldRevisions.n).toBe(0);
    const oldNodes = store.db.prepare('SELECT COUNT(*) AS n FROM nodes WHERE task_id=?').get(confirmed.taskId) as { n: number };
    expect(oldNodes.n).toBe(0);
    store.db.close();
  }, 60_000);

  test('W6: a legacy draft cannot create a feature through conversation confirmation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'confirm-graph-old-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const project = join(root, 'project');
    await mkdir(project, { recursive: true });
    const provider = await openaiServer([{ text: 'Investigated the project' }]); cleanup.push(() => provider.close());
    const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), catalog: { capabilityRoot: join(root, 'capabilities'), recipesPath: join(root, 'recipes.json') }, projects: [{ id: 'p', root: project }],
      models: { apiKey: 'local-only', modelRuntime: provider.runtime, entries: [{ id: 'local', provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256 }] },
      master: { action: 'master', definitionVersion: 'master@1', model: 'local' } });
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'medium' }, 'master');
    cleanup.push(() => runtime.close());
    const created = await runtime.conversations.create({ text: '旧方案', requestId: 'create' });
    await runtime.host.runReady();
    const anchorTaskId = (await runtime.conversations.view(created.conversationId)).anchorTaskId;
    await runtime.conversations.bind(created.conversationId, { projectId: 'p', requestId: 'bind' });
    await expect(runtime.supervisor(anchorTaskId).propose({
      requirementVersion: 1, summary: '旧方案',
      acceptance: [{ id: 'works', description: '检查通过', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
        { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: ['check.js'] } },
      ],
    } as unknown as NativeProposal, 'proposal-old')).rejects.toMatchObject({ code: 'invalid_proposal' });
    await expect(runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' }))
      .rejects.toMatchObject({ code: 'stale_proposal' });
    expect((await runtime.conversations.view(created.conversationId)).tasks).toEqual([]);
    const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM graph_revisions').get()).toEqual({ n: 0 });
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM kernel_graph_owners').get()).toEqual({ n: 0 });
    store.db.close();
  }, 60_000);
