import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { TaskStore } from '../../src/core/store.ts';
import { ArtifactWorkspace } from '../../src/core/artifact-workspace.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';

// The owner must edit a worker's artifact through its real Pi tool, in both
// creation paths. A successful reply alone cannot prove the destination or
// authority: read the immutable versions and their actual producers afterward.
test.each(['confirmed', 'managed'] as const)('main revises %s graph artifacts without transferring authorship or reaching another owner', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-artifact-owner-'));
  const project = join(root, 'project'); await mkdir(project);
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  let graphId = '';
  let foreignId = '';
  const publish = (id: string, content: string, extra: Record<string, unknown> = {}): ResponsePlan => ({ tools: [{ id, name: 'artifact_publish',
    arguments: () => JSON.stringify({ namespace: 'plans', name: 'plan', content, requestId: id, ...extra }) }] });
  const mainPlans: ResponsePlan[] = [{ text: 'Ready to coordinate.' }];
  const mainProvider = await openaiServer(mainPlans);
  const suggestionProvider = await openaiServer([{ text: '' }, { text: '' }, { text: '' }]);
  const workerPlans: ResponsePlan[] = [
    publish('worker-v1', 'Worker original'), { text: 'Original published.' },
    publish('worker-v3', 'Worker revision'), { text: 'Revision published.' },
    publish('intruder', 'Unauthorized replacement'),
    { tools: [{ id: 'scope', name: 'artifact_publish', arguments: () => JSON.stringify({ graphId, namespace: 'plans', name: 'redirected', content: 'Unauthorized target', requestId: 'scope' }) }] },
    { text: 'Publication attempts finished.' },
  ];
  const workerProvider = await openaiServer(workerPlans);
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  let disk: TaskStore | undefined;
  try {
    const stateDir = join(root, 'state');
    runtime = await openTaskRuntime({ stateDir, projects: [{ id: 'p', root: project }], access: () => fullAccessPolicy(),
      catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
      master: { action: 'master', definitionVersion: 'master@1', model: 'main-model' },
      models: { apiKey: 'local-only', modelRuntime: mainProvider.runtime, entries: [
        { id: 'suggestion', provider: mainProvider.model.provider, grade: 'low', api: 'openai-completions', baseUrl: suggestionProvider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
        { id: 'main-model', provider: mainProvider.model.provider, grade: 'high', api: 'openai-completions', baseUrl: mainProvider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
        { id: 'worker-model', provider: mainProvider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: workerProvider.model.baseUrl, contextWindow: 32000, maxTokens: 256 },
      ] } });
    runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'Coordinate graph artifacts.');
    runtime.catalog.publishDefinition('worker', { recommendedGrade: 'medium' }, 'Publish task artifacts.');
    const created = await runtime.conversations.create({ projectId: 'p', text: 'Coordinate the plan', requestId: 'create' });
    await runtime.host.runReady();
    const main = runtime.supervisor(created.taskId);
    const definition = parseGraphDefinition({ schemaVersion: 2, name: 'Artifact ownership', protocols: { job: { type: 'object' } },
      nodes: Object.fromEntries(['author', 'other'].map(id => [id, { recipe: 'worker@1', model: 'worker-model', task: 'Publish the plan',
        inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} }])),
      modules: { check: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'job' } }, outputs: { result: { protocol: 'job' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' } } },
      edges: {}, acceptance: [{ id: 'checked', description: 'Host check succeeds', kind: 'check', module: 'check' }] });
    if (mode === 'confirmed') {
      await main.propose({ requirementVersion: 1, summary: definition.name, definition,
        acceptance: [{ id: 'checked', description: 'Host check succeeds', checkNode: 'check' }] }, 'draft');
      graphId = (await runtime.conversations.confirm(created.conversationId, { proposalVersion: 1, draftRevision: 1, targetBranch: 'main', requestId: 'confirm' })).taskId;
      mainPlans.push({ text: 'Graph ready.' });
      await runtime.host.runReady();
    } else graphId = ((await main.graphCreate({ definition })) as { graphId: string }).graphId;
    const foreign = await runtime.user.begin({ projectId: 'p', request: 'Separate owner', requestId: 'foreign' });
    foreignId = ((await runtime.supervisor(foreign.taskId).graphCreate({ definition })) as { graphId: string }).graphId;
    await main.graphSend({ graphId, nodeId: 'author', input: 'job', value: {} }); await runtime.host.drive();
    expect(runtime.nodeRun(graphId, 'author').node.status).toBe('succeeded');
    const first = runtime.artifacts.list(graphId, { namespace: 'plans', latestOnly: true }).artifacts[0]!;
    expect(first).toMatchObject({ ownerId: graphId, version: 1, producer: { nodeId: 'author' } });
    expect((await runtime.artifacts.read(graphId, first.artifactId, 1)).text).toBe('Worker original');

    mainPlans.push(publish('main-v2', 'Main correction', { graphId, expectedVersion: 1 }),
      publish('main-v2', 'Main correction', { graphId, expectedVersion: 1 }),
      { tools: [{ id: 'foreign', name: 'artifact_publish', arguments: () => JSON.stringify({ graphId: foreignId, namespace: 'plans', name: 'foreign-write', content: 'Wrong owner', requestId: 'foreign' }) }] },
      { text: 'Coordination finished.' });
    await runtime.conversations.chat(created.conversationId, { text: 'Publish a correction in the graph', requestId: 'correct' });
    await runtime.host.runReady();
    const second = runtime.artifacts.get(graphId, first.artifactId);
    expect(second).toMatchObject({ ownerId: graphId, version: 2, producer: { nodeId: 'master' } });
    expect((await runtime.artifacts.read(graphId, first.artifactId, 2)).text).toBe('Main correction');
    expect((await runtime.artifacts.read(graphId, first.artifactId, 1)).text).toBe('Worker original');
    expect(runtime.artifacts.list(foreignId).artifacts).toEqual([]);
    expect(runtime.artifacts.list(created.taskId).artifacts.every(record => record.ownerId === graphId)).toBe(true);
    expect(JSON.stringify(mainProvider.requests.at(-1))).toContain('Artifact publisher does not match');

    // An operation ID belonging to main cannot authenticate a forged node or
    // instance. Exercise the storage owner with the identity from real Pi.
    disk = new TaskStore(join(stateDir, 'tasks.sqlite'));
    const artifacts = new ArtifactWorkspace(disk, join(stateDir, 'artifact-workspace'));
    for (const identity of [{ nodeId: 'other' }, { instanceId: 'forged' }]) {
      await expect(artifacts.publish({ taskId: graphId, workspace: project, namespace: 'plans', name: 'plan', content: 'Forged producer',
        producer: { ...second.producer!, ...identity }, requestId: `forged-${Object.keys(identity)[0]}` })).rejects.toMatchObject({ code: 'permission' });
    }
    expect(() => artifacts.retire(created.taskId, first.artifactId, 2, 'Unauthorized withdrawal', 'missing-actor')).toThrow('Artifact retirement requires');
    expect(() => artifacts.retire(created.taskId, first.artifactId, 2, 'Forged withdrawal', 'forged-retire',
      { ...second.producer!, nodeId: 'other' })).toThrow('Artifact publisher does not match');
    await main.graphSend({ graphId, nodeId: 'author', input: 'job', value: {} }); await runtime.host.drive();
    expect(runtime.artifacts.get(graphId, first.artifactId)).toMatchObject({ version: 3, producer: { nodeId: 'author' } });
    await main.graphSend({ graphId, nodeId: 'other', input: 'job', value: {} }); await runtime.host.drive();
    expect(runtime.artifacts.get(graphId, first.artifactId).version).toBe(3);
    expect((await runtime.artifacts.read(graphId, first.artifactId, 3)).text).toBe('Worker revision');
    expect(runtime.artifacts.list(graphId, { latestOnly: false }).artifacts).toHaveLength(3);
    const attempted = JSON.stringify(workerProvider.requests.at(-1));
    expect(attempted).toContain('Only the original publisher');
    expect(attempted).toContain('Only main can select an artifact graph');
    const retire: ResponsePlan = { tools: [{ id: 'retire', name: 'artifact_retire', arguments: JSON.stringify({
      artifactId: first.artifactId, version: 2, reason: 'Correction superseded by author', requestId: 'retire-v2',
    }) }] };
    mainPlans.push(retire, retire, { text: 'Superseded version withdrawn.' });
    await runtime.conversations.chat(created.conversationId, { text: 'Withdraw the superseded correction', requestId: 'withdraw' });
    await runtime.host.runReady();
    expect(runtime.artifacts.get(graphId, first.artifactId, 2).state).toBe('retired');
    expect((await runtime.artifacts.read(graphId, first.artifactId, 2)).text).toBe('Main correction');
    expect(runtime.artifacts.get(graphId, first.artifactId)).toMatchObject({ version: 3, state: 'published' });
    const withdrawals = disk.db.prepare("SELECT task_id FROM events WHERE type='artifact.retired'").all();
    expect(withdrawals).toEqual([{ task_id: graphId }]);

    // Project knowledge remains available to main, but graph nodes discover
    // only their own shared workspace, including artifacts by other nodes.
    const promoted = await runtime.artifacts.promote({ taskId: graphId, artifactId: first.artifactId, version: 3, requestId: 'promote-plan' });
    mainPlans.push({ tools: [{ id: 'main-list', name: 'artifact_list', arguments: '{}' }] }, { text: 'Project knowledge discovered.' });
    await runtime.conversations.chat(created.conversationId, { text: 'List shared artifacts', requestId: 'list-main' });
    await runtime.host.runReady();
    const mainMessages = (mainProvider.requests.at(-1) as { messages: { tool_call_id?: string; content: string }[] }).messages;
    const mainPage = JSON.parse(mainMessages.find(message => message.tool_call_id === 'main-list')!.content);
    expect(mainPage.artifacts).toEqual(expect.arrayContaining([expect.objectContaining({ artifactId: promoted.artifactId, scope: 'project' })]));

    workerPlans.push({ tools: [{ id: 'node-list', name: 'artifact_list', arguments: JSON.stringify({ latestOnly: false, includeRetired: true, limit: 2 }) }] },
      { tools: [{ id: 'node-next', name: 'artifact_list', arguments: JSON.stringify({ latestOnly: false, includeRetired: true, limit: 2, cursor: '2' }) }] },
      { text: 'Graph workspace discovered.' });
    await main.graphSend({ graphId, nodeId: 'other', input: 'job', value: {} }); await runtime.host.drive();
    const nodeMessages = (workerProvider.requests.at(-1) as { messages: { tool_call_id?: string; content: string }[] }).messages;
    const page = JSON.parse(JSON.parse(nodeMessages.find(message => message.tool_call_id === 'node-list')!.content).content[0].text);
    const next = JSON.parse(JSON.parse(nodeMessages.find(message => message.tool_call_id === 'node-next')!.content).content[0].text);
    expect(page).toMatchObject({ total: 3, nextCursor: '2' });
    expect(next).toMatchObject({ total: 3, nextCursor: null });
    expect([...page.artifacts, ...next.artifacts]).toEqual(expect.arrayContaining([1, 2, 3].map(version => expect.objectContaining({
      artifactId: first.artifactId, scope: 'task', ownerId: graphId, version,
    }))));
    expect([...page.artifacts, ...next.artifacts]).toHaveLength(3);
  } finally {
    await runtime?.close(); disk?.close(); await workerProvider.close(); await mainProvider.close(); await suggestionProvider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
