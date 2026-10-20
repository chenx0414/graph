import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from '../../src/server/app.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import { afterEach, expect, test } from 'vitest';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { assembleMattTeam } from '../../src/catalog/matt-team.ts';
import { openaiServer, type ResponsePlan } from '../fixtures/openai-server.ts';
import { git } from '../fixtures/native-git-acceptance.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const options = { name: 'Matt behavior', task: 'Build the approved feature', spec: 'docs/specs/feature.md', ticket: 5, baseRef: 'main', check: { command: 'node', args: ['--version'] } };

test('Matt assembly reports every missing capability before saving any role', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-matt-assembly-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities'); await mkdir(capabilityRoot);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') } });
  cleanup.push(() => runtime.close());
  const app = await createApp(runtime, { origin: 'http://127.0.0.1:1' }); cleanup.push(() => app.close());
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const configuration = join(root, 'missing-options.json'); const output = join(root, 'missing-team.json');
  await writeFile(configuration, JSON.stringify(options));
  const before = runtime.catalog.agentCombinations();
  const failed = await promisify(execFile)(process.execPath, ['examples/assemble-matt-team.ts', '--url', url, '--config', configuration, '--out', output],
    { cwd: process.cwd() }).then(() => null, error => error as { code: number; stderr: string });
  expect(failed?.code).toBe(1);
  expect(failed?.stderr).toMatch(/planner.*codebase-design[\s\S]*worker.*tdd[\s\S]*standards.*code-review[\s\S]*spec.*code-review/);
  expect(runtime.catalog.agentCombinations()).toEqual(before);
  expect(await access(output).then(() => true, () => false)).toBe(false);
});

async function mattCapabilities(root: string) {
  const target = join(root, 'capabilities'); await mkdir(target);
  for (const name of ['codebase-design', 'tdd', 'code-review']) {
    const id = `mattpocock-skills-skills-engineering-${name}`;
    const destination = join(target, id);
    await cp(join(process.cwd(), '.agents', 'skills', name), destination, { recursive: true });
    const version = createHash('sha256').update(await readFile(join(destination, 'SKILL.md'))).digest('hex').slice(0, 12);
    await writeFile(join(destination, 'capability.json'), JSON.stringify({ id, name, kind: 'skill', version, source: 'local:.agents/skills' }));
  }
  return target;
}

test('the shipped assembly CLI compiles versioned recipes and saves reusable JSON through the actual catalog HTTP surface', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-matt-version-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = await mattCapabilities(root);
  const runtime = await openTaskRuntime({ stateDir: join(root, 'state'), projects: [{ id: 'p', root }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') } });
  cleanup.push(() => runtime.close());
  await runtime.catalog.saveAgentCombination({ id: 'matt-team-worker', name: 'Earlier worker', description: 'Old role', recommendedGrade: 'medium', review: false, tags: [], resources: [], systemPrompt: 'Old instructions' });
  const app = await createApp(runtime, { origin: 'http://127.0.0.1:1' }); cleanup.push(() => app.close());
  const url = await app.listen({ host: '127.0.0.1', port: 0 });
  const configuration = join(root, 'team-options.json'); const output = join(root, 'team.json');
  await writeFile(configuration, JSON.stringify(options));
  await promisify(execFile)(process.execPath, ['examples/assemble-matt-team.ts', '--url', url, '--config', configuration, '--out', output], { cwd: process.cwd() });
  const definition = parseGraphDefinition(JSON.parse(await readFile(output, 'utf8')));
  expect(definition.nodes.worker!.recipe).toBe('matt-team-worker@2');
  const persisted = JSON.stringify(definition);
  const second = await assembleMattTeam(runtime.catalog, { ...options, name: 'Another task' });
  expect(second.nodes.worker!.recipe).toBe('matt-team-worker@2');
  expect(JSON.parse(persisted).name).toBe('Matt behavior');
});

test('Matt plan drives implementation, two independent axes return rework to the original worker, and final delivery requires current commit evidence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-matt-execution-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project'); await mkdir(project);
  await writeFile(join(project, 'README.md'), 'Approved feature\n');
  await writeFile(join(project, 'feature.txt'), 'incomplete');
  await writeFile(join(project, 'check.cjs'), "if(require('fs').readFileSync('feature.txt','utf8')!=='done')process.exit(1)");
  git(project, ['init', '-q', '-b', 'main']); git(project, ['add', '.']); git(project, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']);
  const baseline = git(project, ['rev-parse', 'HEAD']);
  const capabilityRoot = await mattCapabilities(root);
  let runtime!: Awaited<ReturnType<typeof openTaskRuntime>>; let graphId = '';
  const reference = (namespace: string, name: string, version?: number) => {
    const item = runtime.artifacts.list(graphId, { namespace, latestOnly: version === undefined }).artifacts.find(item => item.name === name && (version === undefined || item.version === version))!;
    return { artifactId: item.artifactId, version: item.version, digest: item.digest };
  };
  const tool = (name: string, value: () => unknown): ResponsePlan => ({ tools: [{ id: name, name, arguments: () => JSON.stringify(value()) }] });
  const submit = (value: () => unknown) => tool('submit', () => ({ outputs: { result: { enable: true, value: value() } } }));
  const skillPath = (name: string) => join(capabilityRoot, `mattpocock-skills-skills-engineering-${name}`, 'SKILL.md');
  const planner = await openaiServer([
    tool('read', () => ({ path: skillPath('codebase-design') })),
    tool('artifact_publish', () => ({ namespace: 'plans', name: 'plan', mediaType: 'text/markdown', content: 'Plan: feature.txt must contain done; test the check.cjs seam; use tdd.', requestId: 'plan' })),
    submit(() => ({ plan: reference('plans', 'plan'), spec: options.spec, ticket: 5, baseRef: baseline })), { text: 'Plan published.' },
  ]);
  let releaseWorker!: () => void;
  const workerHeld = new Promise<void>(resolve => { releaseWorker = resolve; });
  let workerSubmitted!: () => void;
  const submitted = new Promise<void>(resolve => { workerSubmitted = resolve; });
  const worker = await openaiServer([1, 2].flatMap(round => [
    tool('read', () => ({ path: skillPath('tdd') })),
    tool('artifact_read', () => reference('plans', 'plan')),
    ...(round === 2 ? ['standards', 'spec'].map(axis => tool('artifact_read', () => reference('reviews', axis, 1))) : []),
    tool('write_file', () => ({ path: 'feature.txt', content: round === 1 ? 'incomplete' : 'done' })),
    tool('workspace_commit', () => ({ paths: ['feature.txt'], message: `Implement round ${round} (#5)` })),
    tool('artifact_publish', () => ({ namespace: 'deliverables', name: 'implementation', sourcePath: 'feature.txt', metadata: { kind: 'code' }, requestId: `implementation-${round}` })),
    submit(() => ({ plan: reference('plans', 'plan'), subject: reference('deliverables', 'implementation', round) })),
    { text: `Implementation ${round} published.`, ...(round === 1 ? { beforeReply: async () => { workerSubmitted(); await workerHeld; } } : {}) },
  ]));
  const reviewers: Record<string, Awaited<ReturnType<typeof openaiServer>>> = {};
  const observed: Record<string, { commit: string; content: string }[]> = { standards: [], spec: [] };
  for (const axis of ['standards', 'spec']) {
    let actualCommit = ''; let actualContent = ''; let reviewedContent = '';
    const toolText = (name: string): string => {
      const request = JSON.parse(JSON.stringify(reviewers[axis]!.requests.at(-1)));
      const message = request.messages.filter((item: { role: string; tool_call_id?: string }) => item.role === 'tool' && item.tool_call_id === name).at(-1);
      try { return JSON.parse(message.content).content.map((item: { text?: string }) => item.text ?? '').join(''); }
      catch { return message.content; }
    };
    reviewers[axis] = await openaiServer([1, 2, 3].flatMap(round => [
      tool('read', () => ({ path: skillPath('code-review') })),
      tool('artifact_read', () => reference('plans', 'plan')),
      tool('artifact_read', () => reference('deliverables', 'implementation', Math.min(round, 2))),
      tool('bash', () => ({ command: 'if printf UNAUTHORIZED_WRITE 2>/dev/null > feature.txt; then echo UNAUTHORIZED_WRITE; else git rev-parse HEAD && cat feature.txt; fi' })),
      { ...tool('artifact_publish', () => ({ namespace: 'reviews', name: axis, schema: 'graph.review@1', mediaType: 'application/json',
        content: JSON.stringify({ plan: reference('plans', 'plan'), subject: reference('deliverables', 'implementation', Math.min(round, 2)), axis,
          commit: round === 3 ? actualCommit : baseline, passed: reviewedContent === 'done', reason: reviewedContent === 'done' ? `${axis}: exact implementation contains done` : `${axis}: feature is incomplete` }), requestId: `${axis}-${round}` })),
        beforeReply: () => {
          const inspected = toolText('bash').trim();
          actualCommit = inspected.match(/[a-f0-9]{40}/)?.[0] ?? '';
          actualContent = inspected.match(/(?:incomplete|done)$/)?.[0] ?? inspected;
          // Immediate review can read the published code before its source is
          // integrated. Final review must also read the settled worktree.
          reviewedContent = round === 3 ? actualContent : JSON.parse(toolText('artifact_read')).text;
          observed[axis]!.push({ commit: actualCommit, content: actualContent });
        } },
      submit(() => ({ plan: reference('plans', 'plan'), subject: reference('deliverables', 'implementation', Math.min(round, 2)), report: reference('reviews', axis, round),
        commit: round === 3 ? actualCommit : baseline, passed: reviewedContent === 'done', reason: reviewedContent === 'done' ? `${axis}: exact implementation contains done` : `${axis}: feature is incomplete` })),
      { text: `${axis} review ${round} published.` },
    ]));
  }
  for (const provider of [planner, worker, ...Object.values(reviewers)]) cleanup.push(() => provider.close());
  const providers = { planner, worker, ...reviewers };
  runtime = await openTaskRuntime({ sessionTransport: createDurableSessionTransport, access: () => fullAccessPolicy(), stateDir: join(root, 'state'), projects: [{ id: 'p', root: project }], catalog: { capabilityRoot, recipesPath: join(root, 'recipes.json') },
    models: { apiKey: 'local-only', modelRuntime: worker.runtime, entries: Object.entries(providers).map(([id, provider]) => ({
      id, modelId: id, provider: provider.model.provider, grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 128_000, maxTokens: 256,
    })) } });
  cleanup.push(() => runtime.close());
  const definition = await assembleMattTeam(runtime.catalog, { ...options, baseRef: baseline, check: { command: 'node', args: ['check.cjs'] }, models: { planner: 'planner', worker: 'worker', standards: 'standards', spec: 'spec' } });
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: options.task, requestId: 'begin' }); const main = runtime.supervisor(taskId);
  graphId = ((await main.graphCreate({ definition, targetBranch: 'main' })) as { graphId: string }).graphId;
  const workerInstance = runtime.nodeRun(graphId, 'worker').instance!.id;
  await main.graphSend({ graphId, input: 'job', value: { goal: options.task } });
  const firstDrive = runtime.host.drive();
  cleanup.push(async () => { releaseWorker(); await firstDrive; });
  await submitted;
  type ReviewExecution = { id: string; nodeId: string; state: string; attempt: number; retriesUsed: number };
  let preparing!: ReviewExecution;
  await expect.poll(async () => {
    const history = await main.graphInspect({ graphId, query: 'executions' }) as { items: ReviewExecution[] };
    preparing = history.items.find(item => item.nodeId === 'standards')!;
    return preparing?.state;
  }).toBe('running');
  // A reviewer waiting for its producer has not called the model. Pausing that
  // preparation must retain its delivery and must not spend an automatic retry.
  await main.graphControl({ graphId, nodeId: 'standards', action: 'pause' });
  releaseWorker(); await firstDrive;
  const paused = await main.graphInspect({ graphId, query: 'executions' }) as { items: ReviewExecution[] };
  expect(paused.items.find(item => item.id === preparing.id)).toMatchObject({ state: 'blocked', attempt: 0, retriesUsed: 0 });
  expect(reviewers.standards!.requests).toHaveLength(0);
  await main.graphControl({ graphId, nodeId: 'standards', action: 'resume' });
  await runtime.host.drive();
  const resumed = await main.graphInspect({ graphId, query: 'executions' }) as { items: ReviewExecution[] };
  expect(resumed.items.find(item => item.id === preparing.id)).toMatchObject({ state: 'completed', attempt: 1, retriesUsed: 0 });
  const results = await main.graphInspect({ graphId, query: 'results' }) as { value: { subject: { artifactId: string; version: number; digest: string }; plan: { digest: string }; passed: boolean } }[];
  expect(results).toMatchObject([{ value: { passed: true, subject: reference('deliverables', 'implementation', 2), plan: reference('plans', 'plan') } }]);
  expect(runtime.nodeRun(graphId, 'worker').session?.sessionFile).toMatch(/^durable:/);
  for (const axis of ['standards', 'spec']) expect(observed[axis]!.map(item => item.content)).toEqual(['incomplete', 'done']);
  expect(runtime.nodeRun(graphId, 'worker').instance).toMatchObject({ id: workerInstance });
  expect(runtime.nodeRun(graphId, 'worker').instance!.used).toBeGreaterThan(0);
  const history = await main.graphInspect({ graphId, query: 'executions' }) as { items: { nodeId: string; state: string }[] };
  expect(history.items.filter(item => item.nodeId === 'worker')).toHaveLength(2);
  expect(history.items.every(item => item.state === 'completed')).toBe(true);
  expect(JSON.stringify(worker.requests)).toContain('Plan: feature.txt must contain done');
  expect(JSON.stringify(worker.requests)).toContain('Seams: where tests go');
  expect(JSON.stringify(worker.requests)).toContain('feature is incomplete');
  expect(JSON.stringify(reviewers.spec!.requests)).toContain('Two-axis review of the diff');
  expect((await runtime.artifacts.read(graphId, reference('deliverables', 'implementation', 1).artifactId, 1)).text).toBe('incomplete');
  expect((await runtime.artifacts.read(graphId, reference('deliverables', 'implementation', 2).artifactId, 2)).text).toBe('done');
  await main.graphSend({ graphId, input: 'check', value: {} }); await runtime.host.drive();
  await expect(main.graphInspect({ graphId, query: 'acceptance' })).resolves.toMatchObject({ ready: false, items: [{ status: 'passed' }, { status: 'stale' }, { status: 'stale' }] });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect((await runtime.user.task(graphId).view()).phase).toBe('blocked');
  await main.graphControl({ graphId, action: 'withdraw_complete' });
  // Main pauses and queues the final review after the source has settled;
  // resuming must refresh these same reviewers' existing private copies.
  for (const nodeId of ['standards', 'spec']) await main.graphControl({ graphId, nodeId, action: 'pause' });
  for (const nodeId of ['standards', 'spec']) await main.graphSend({ graphId, nodeId, input: 'job', value: { plan: reference('plans', 'plan'), subject: reference('deliverables', 'implementation', 2) } });
  await runtime.host.drive();
  for (const nodeId of ['standards', 'spec']) await main.graphControl({ graphId, nodeId, action: 'resume' });
  await runtime.host.drive();
  for (const axis of ['standards', 'spec']) {
    expect(observed[axis]!.at(-1)).toEqual({ commit: (await runtime.user.task(graphId).view()).integrationSha, content: 'done' });
  }
  await expect(main.graphInspect({ graphId, query: 'acceptance' })).resolves.toMatchObject({ ready: true, items: [{ status: 'passed' }, { status: 'passed' }, { status: 'passed' }] });
  await main.graphControl({ graphId, action: 'complete' }); await runtime.host.drive();
  expect((await runtime.user.task(graphId).view()).phase).toBe('completed');
  expect(await readFile(join(project, 'feature.txt'), 'utf8')).toBe('done');
  const other = ((await main.graphCreate({ definition })) as { graphId: string }).graphId;
  expect(runtime.nodeRun(other, 'worker').instance!.id).not.toBe(workerInstance);
  expect(runtime.artifacts.list(other, {}).artifacts).toEqual([]);
}, 60_000);
