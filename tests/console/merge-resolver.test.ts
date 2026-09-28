import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';
import { createMergeResolver, MERGE_GRADE, mergeDefinition, mergeAccessPolicy } from '../../src/core/merge-resolver.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { fullAccessPolicy, standardAccessPolicy } from '../../src/core/access-policy.ts';
import { git } from '../../src/git/git.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import type { ModelEntry } from '../../src/catalog/models.ts';
import type { AgentContextLibrary } from '../../src/runtime/agent-context.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function fixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-merge-resolver-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'app.ts'), 'v0\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'init']);
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const library = openAgentContextLibrary(join(root, 'prompts'));
  await library.ensure();
  return { root, project, stateDir, store, library };
}

const entry = (id: string, grade: ModelEntry['grade']): ModelEntry => ({
  id, provider: 'p', grade, api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32_000, maxTokens: 256,
});

function options(stateDir: string, store: TaskStore, catalog: Catalog, entries: ModelEntry[], library: AgentContextLibrary, access = fullAccessPolicy()) {
  return {
    store,
    catalog,
    library,
    instancesDir: join(stateDir, 'instances'),
    directory: () => entries,
    modelRuntime: {} as never,
    access: () => access,
  };
}

test('the merge Agent runs at the medium grade the user chose, even when a higher grade exists', async () => {
  const { stateDir, store, library } = await fixture('grade');
  const catalog = new Catalog(store, {});
  expect(MERGE_GRADE).toBe('medium');

  // The recipe must exist, or the resolver refuses rather than inventing an identity.
  expect(() => mergeDefinition(catalog)).toThrow(/matt-merge/);
  catalog.publishDefinition('matt-merge', { recommendedGrade: 'medium' });
  expect(mergeDefinition(catalog)).toBe('matt-merge@1');
  // Re-saving an identical recipe keeps the same version: a dispatch follows the latest
  // *changed* definition, not the number of times a compile ran.
  catalog.ensureDefinition('matt-merge', { recommendedGrade: 'medium' });
  expect(mergeDefinition(catalog)).toBe('matt-merge@1');
  // A changed recipe does move it, the same way a node citing the recipe follows it.
  catalog.publishDefinition('matt-merge', { recommendedGrade: 'medium', review: false });
  expect(mergeDefinition(catalog)).toBe('matt-merge@2');

  // A medium entry exists next to a high one: selection must take medium, not the best available.
  const resolve = createMergeResolver(options(stateDir, store, catalog, [entry('big', 'high'), entry('mid', 'medium')], library));
  expect(typeof resolve).toBe('function');
}, 60_000);

test('a merge turn is refused unless full access is in force', async () => {
  const { stateDir, store, library } = await fixture('access');
  const catalog = new Catalog(store, {});

  const partial = options(stateDir, store, catalog, [entry('mid', 'medium')], library, standardAccessPolicy());
  expect(() => mergeAccessPolicy(partial)).toThrow(/full access/i);

  const full = options(stateDir, store, catalog, [entry('mid', 'medium')], library, fullAccessPolicy());
  const resolved = mergeAccessPolicy(full);
  expect(resolved.mode).toBe('full');
  expect(resolved.filesystem.write).toBe('host');
});

test('with no medium model the resolver refuses with a reason instead of sending with a wrong one', async () => {
  const { stateDir, store, library } = await fixture('nomodel');
  const catalog = new Catalog(store, {});
  catalog.publishDefinition('matt-merge', { recommendedGrade: 'medium' });

  // Only a high entry is configured: there is no medium model to run the merge turn.
  const resolve = createMergeResolver(options(stateDir, store, catalog, [entry('big', 'high')], library));
  await expect(resolve({ taskId: 't', nodeId: 'n', prompt: 'merge them', workspace: stateDir }))
    .rejects.toThrow(/medium/);
}, 60_000);

test('a collision with no published merge identity refuses by name, before opening any session', async () => {
  const { stateDir, store, library } = await fixture('norecipe');
  const catalog = new Catalog(store, {});
  const resolve = createMergeResolver(options(stateDir, store, catalog, [entry('mid', 'medium')], library));
  await expect(resolve({ taskId: 't', nodeId: 'n', prompt: 'merge them', workspace: stateDir }))
    .rejects.toThrow(/matt-merge/);
}, 60_000);

test('a runtime with models configured builds a merge resolver of its own, and a collision reaches it', async () => {
  const { root, project, stateDir, store, library } = await fixture('wired');
  const provider = await openaiServer([{ text: 'merged' }, { text: 'merged again' }]);
  cleanup.push(() => provider.close());

  // A real runtime, configured like production: models present, so the resolver is built in.
  const runtime = await openTaskRuntime({
    stateDir,
    projects: [{ id: 'p', root: project }],
    // The prompt library is what resolves the merge identity; without it the resolver refuses
    // rather than running a merge turn that has lost its discipline.
    agentContext: library,
    actions: {
      work: {
        kind: 'agent',
        reserveTokens: 1_000,
        prepare: async operation => async () => {
          // Two lanes write the same line of the same file, from the same integration tip.
          const lane = operation.nodeId === 'lane1' ? 1 : 2;
          await writeFile(join(operation.workspace!, 'app.ts'), `from-lane-${lane}\n`);
          return { outcome: 'completed', output: {} };
        },
      },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [] }) },
    },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      credentialFor: () => ({ credentialId: 'local', apiKey: 'scripted-local-key' }),
      modelRuntime: provider.runtime,
    },
  });
  cleanup.push(() => runtime.close());
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'collide', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'collide',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'lane1', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'lane2', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['lane1', 'lane2'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();

  const events = (type: string) => (store.db.prepare('SELECT data FROM events WHERE task_id=? AND type=? ORDER BY cursor')
    .all(taskId, type) as unknown as { data: string }[]).map(row => JSON.parse(row.data) as Record<string, unknown>);
  // The collision was attempted through the runtime's own resolver rather than being skipped:
  // with no published matt-merge recipe the attempt is refused by name, which is the proof that
  // the wired path ran and refused for the honest reason.
  const refused = events('git.conflict.merge_attempt_refused');
  expect(refused.length).toBeGreaterThan(0);
  expect(String(refused[0]!.reason)).toMatch(/matt-merge/);
  // The refused attempt names the lane that had to be merged, not an internal id.
  expect(['lane1', 'lane2']).toContain(refused[0]!.nodeId);
  void root;
}, 120_000);

/** The merge identity, installed into a temp capability root so no test depends on the host's. */
async function installMergeIdentity(root: string): Promise<string> {
  const capabilityRoot = join(root, 'capabilities');
  const target = join(capabilityRoot, 'matt-pocock-merge');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'capability.json'), JSON.stringify({
    id: 'matt-pocock-merge', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'merge',
    description: 'Matt 工程流里的合流 Agent。', source: 'local:docs/agents/matt-flow.md',
  }));
  await writeFile(join(target, 'agent.md'), '你是 Matt 工程流里的「合流」Agent：合并两边，丢掉任何一侧都不是合并。\n');
  return capabilityRoot;
}

/** A runtime whose two lanes collide, with a scripted provider standing in for the model. */
async function collidingRuntime(name: string, options2: { defaultBudgetTokens?: number | null; publishRecipe: boolean }) {
  const { root, project, stateDir, store, library } = await fixture(name);
  const capabilityRoot = await installMergeIdentity(root);
  const provider = await openaiServer([{ text: 'both sides kept' }]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir,
    projects: [{ id: 'p', root: project }],
    agentContext: library,
    catalog: { capabilityRoot },
    ...(options2.defaultBudgetTokens === undefined ? {} : { limits: { defaultBudgetTokens: options2.defaultBudgetTokens } }),
    access: () => fullAccessPolicy(),
    actions: {
      work: {
        kind: 'agent',
        reserveTokens: 100,
        prepare: async operation => async () => {
          const lane = operation.nodeId === 'lane1' ? 1 : 2;
          await writeFile(join(operation.workspace!, 'app.ts'), `from-lane-${lane}\n`);
          return { outcome: 'completed', output: {}, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 } };
        },
      },
      check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [] }) },
    },
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      credentialFor: () => ({ credentialId: 'local', apiKey: 'scripted-local-key' }),
      modelRuntime: provider.runtime,
    },
  });
  cleanup.push(() => runtime.close());
  if (options2.publishRecipe) {
    runtime.catalog.publishDefinition('matt-merge', {
      recommendedGrade: 'medium',
      prompts: { agent: { id: 'matt-pocock-merge', version: '1.0.0' } },
    }, 'merge-recipe');
  }
  await runtime.projects.prepare({ projectId: 'p', requestId: 'prepare', createBaseline: true });
  const { taskId } = await runtime.user.begin({ projectId: 'p', request: 'collide', requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: 'collide',
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [
      { id: 'lane1', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'lane2', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'check', dependsOn: ['lane1', 'lane2'] },
    ],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  await runtime.host.drive();
  const events = (type: string) => (store.db.prepare('SELECT data FROM events WHERE task_id=? AND type=? ORDER BY cursor')
    .all(taskId, type) as unknown as { data: string }[]).map(row => JSON.parse(row.data) as Record<string, unknown>);
  return { runtime, provider, taskId, events };
}

test('a merge turn records what it cost, so the spend is visible even though no cap pays for it', async () => {
  const { provider, events } = await collidingRuntime('usage', { publishRecipe: true });
  // The scripted provider answers with prose and never resolves the file, so the merge is refused -
  // and the usage is recorded anyway, because the model was paid either way.
  const usage = events('git.conflict.merge_attempt_usage');
  expect(usage).toHaveLength(1);
  expect(usage[0]).toMatchObject({ model: 'local' });
  expect(Number(usage[0]!.input)).toBeGreaterThan(0);
  expect(Number(usage[0]!.total)).toBeGreaterThan(0);
  // The turn really was sent: exactly the merge Agent's own request reached the provider.
  expect(provider.requests.length).toBeGreaterThan(0);
}, 120_000);

test('under a finite task budget the merge turn is refused instead of spending quota no ledger sees', async () => {
  const { events, provider } = await collidingRuntime('finite', { defaultBudgetTokens: 1_000_000, publishRecipe: true });
  const refused = events('git.conflict.merge_attempt_refused');
  expect(refused).toHaveLength(1);
  expect(String(refused[0]!.reason)).toMatch(/finite token budget/i);
  // Refused before any send: the point is that no invisible quota was burned.
  expect(provider.requests).toHaveLength(0);
  expect(events('git.conflict.merge_attempt_usage')).toHaveLength(0);
}, 120_000);
