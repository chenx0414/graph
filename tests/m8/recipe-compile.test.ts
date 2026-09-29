import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createApp } from '../../src/server/app.ts';
import type { AgentCombination } from '../../src/catalog/agent-combinations.ts';
import { openAgentContextAssembly } from '../../src/runtime/agent-context-assembly.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

/* Sandbox-safe: pure Catalog logic plus an in-process Fastify `inject` route
 * check and source-level assertions. No browser, no ports, no child processes. */

async function writeCapability(root: string, id: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const directory = join(root, id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'capability.json'), JSON.stringify({ id, ...manifest }, null, 2));
  for (const [name, body] of Object.entries(files)) {
    const target = join(directory, name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
}

async function catalogFixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  await writeCapability(capabilityRoot, 'research', { kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  await writeCapability(capabilityRoot, 'identity', { kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Identity' }, { 'agent.md': 'Identity.\n' });
  const recipesPath = join(root, 'agent-combinations.json');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot, recipesPath });
  await catalog.refresh();
  return { root, capabilityRoot, recipesPath, catalog };
}

const workerRecipe = (overrides: Partial<AgentCombination> = {}): AgentCombination => ({
  id: 'worker',
  name: 'Worker',
  description: 'Use one skill.',
  recommendedGrade: 'medium',
  review: false,
  tags: ['worker'],
  resources: [{ resourceId: 'research', version: '1.0.0', role: 'skill', required: true }],
  ...overrides,
});

test('saving a non-main recipe compiles it immediately and publishes a definition', async () => {
  const { catalog } = await catalogFixture('recipe-compile');
  const result = await catalog.saveAgentCombination(workerRecipe());

  expect(result.combination).toMatchObject({ id: 'worker', status: 'valid' });
  expect(result.combination.mode).toBeUndefined();
  expect(result.compileError).toBeUndefined();
  expect(result.definition?.definitionVersion).toBe('worker@1');
  expect(catalog.definition('worker@1')).toMatchObject({
    id: 'worker',
    version: 1,
    capabilities: [{ id: 'research', version: '1.0.0' }],
  });
});

test('an inline recipe prompt is versioned and reaches the next Agent operation', async () => {
  const { root, catalog } = await catalogFixture('recipe-inline-prompt');
  const first = await catalog.saveAgentCombination(workerRecipe({ resources: [], systemPrompt: 'You are a climate data specialist.' }));
  expect(first.definition?.definitionVersion).toBe('worker@1');
  await catalog.saveAgentCombination(workerRecipe({ resources: [], systemPrompt: 'You are a bioinformatics specialist.' }));
  expect(catalog.definition('worker@1').systemPrompt).toBe('You are a climate data specialist.');
  expect(catalog.definition('worker@2').systemPrompt).toBe('You are a bioinformatics specialist.');
  const assembly = await openAgentContextAssembly({ catalog, workspace: root, definitionVersion: 'worker@2', action: 'work', role: 'worker' });
  const operation = await assembly.bundle.openOperation({ workspace: root, scratchDir: join(root, 'scratch'), action: 'work',
    gate: { dispatch: (_id, _reservation, send) => send(), settle: () => {} }, hostTools: () => [] });
  expect(assembly.forOperation(operation).composed.text).toContain('You are a bioinformatics specialist.');
  expect(assembly.forOperation(operation).composed.text).not.toContain('climate data specialist');
  await operation.close();
});

test('re-saving an identical recipe reuses the published definition instead of publishing a new version', async () => {
  const { catalog } = await catalogFixture('recipe-idempotent');
  const first = await catalog.saveAgentCombination(workerRecipe());
  const second = await catalog.saveAgentCombination(workerRecipe());

  expect(first.definition?.definitionVersion).toBe('worker@1');
  expect(second.definition?.definitionVersion).toBe('worker@1');
  expect(second.definition?.version).toBe(first.definition?.version);
  expect(catalog.listDefinitions()).toEqual([{ id: 'worker', version: 1 }]);
});

test('saving a recipe with an unresolved reference is rejected without persisting or compiling', async () => {
  const { catalog } = await catalogFixture('recipe-invalid-ref');
  await expect(catalog.saveAgentCombination(workerRecipe({
    id: 'ghost',
    resources: [{ resourceId: 'missing-capability', version: '1.0.0', role: 'skill', required: true }],
  }))).rejects.toThrow(/Missing required capability missing-capability/);

  expect(catalog.agentCombinations().map(item => item.id)).not.toContain('ghost');
  expect(catalog.listDefinitions()).toEqual([]);
});

test('a compile failure keeps the saved recipe and reports the error instead of publishing a definition', async () => {
  const { catalog } = await catalogFixture('recipe-compile-error');
  const spy = vi.spyOn(catalog, 'compileAgentCombination').mockImplementation(() => {
    throw new Error('compile exploded');
  });
  try {
    const result = await catalog.saveAgentCombination(workerRecipe());
    expect(result.combination).toMatchObject({ id: 'worker', status: 'valid' });
    expect(result.definition).toBeUndefined();
    expect(result.compileError).toContain('compile exploded');
    // The recipe stayed persisted even though compilation failed.
    expect(catalog.agentCombinations().map(item => item.id)).toEqual(['worker']);
    expect(catalog.listDefinitions()).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test('updating a recipe description still compiles a fresh version', async () => {
  const { catalog } = await catalogFixture('recipe-description');
  await catalog.saveAgentCombination(workerRecipe());
  const updated = await catalog.updateAgentCombinationDescription('worker', '独立实现并验证。');

  expect(updated.combination.description).toBe('独立实现并验证。');
  expect(updated.definition.definitionVersion).toBe('worker@2');
  expect(catalog.definition('worker@2').snapshot).toMatchObject({
    agentCombination: { id: 'worker', description: '独立实现并验证。' },
  });
});

test('the catalog save endpoint returns the compiled definition while the legacy compile endpoint stays available', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-recipe-api-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  await writeCapability(capabilityRoot, 'research', { kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root }],
    catalog: { capabilityRoot, recipesPath: join(root, 'agent-combinations.json') },
  });
  cleanup.push(() => runtime.close());
  const origin = 'http://127.0.0.1:1';
  const app = await createApp(runtime, { origin });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const cookie = String(home.headers['set-cookie'] ?? '');
  const headers = { origin, cookie, 'content-type': 'application/json' };

  const saved = await app.inject({
    method: 'POST',
    url: '/api/catalog/combinations',
    headers,
    payload: JSON.stringify({ combination: workerRecipe() }),
  });
  expect(saved.statusCode).toBe(200);
  const body = JSON.parse(saved.body) as {
    combination: { id: string; status: string };
    definition: { definitionVersion: string };
  };
  expect(body.combination).toMatchObject({ id: 'worker', status: 'valid' });
  expect(body.definition.definitionVersion).toBe('worker@1');

  const legacy = await app.inject({ method: 'POST', url: '/api/catalog/combinations/worker/compile', headers, payload: '{}' });
  expect(legacy.statusCode).toBe(200);
  expect(JSON.parse(legacy.body)).toMatchObject({ definitionVersion: 'worker@1' });
});

test('the description and delete endpoints change the recipe through the same door the console uses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-recipe-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  await writeCapability(capabilityRoot, 'research', { kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  const recipesPath = join(root, 'agent-combinations.json');
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root }],
    catalog: { capabilityRoot, recipesPath },
  });
  cleanup.push(() => runtime.close());
  const origin = 'http://127.0.0.1:1';
  const app = await createApp(runtime, { origin });
  cleanup.push(() => app.close());
  const home = await app.inject({ method: 'GET', url: '/', headers: { origin } });
  const cookie = String(home.headers['set-cookie'] ?? '');
  const headers = { origin, cookie, 'content-type': 'application/json' };

  const saved = await app.inject({ method: 'POST', url: '/api/catalog/combinations', headers, payload: JSON.stringify({ combination: workerRecipe() }) });
  expect(saved.statusCode).toBe(200);

  // Editing the description is a save of the same recipe: the definition has to move with it, or the
  // library would show text the compiled identity does not carry.
  const described = await app.inject({
    method: 'POST',
    url: '/api/catalog/combinations/worker/description',
    headers,
    payload: JSON.stringify({ description: '把一件事做完。' }),
  });
  expect(described.statusCode).toBe(200);
  expect(JSON.parse(described.body)).toMatchObject({ combination: { description: '把一件事做完。' }, definition: { version: 2 } });
  expect(JSON.parse(await readFile(recipesPath, 'utf8')).combinations.find((item: { id: string }) => item.id === 'worker').description).toBe('把一件事做完。');
  expect((await runtime.catalog.definitions()).find(item => item.id === 'worker')?.version).toBe(2);

  // Deleting carries no body at all, so asking for JSON here is the trap: Fastify refuses an empty
  // JSON body with 400 before the route ever runs, and the console sends no content-type for it.
  const asJson = await app.inject({ method: 'DELETE', url: '/api/catalog/combinations/worker', headers: { origin, cookie, 'content-type': 'application/json' } });
  expect(asJson.statusCode).toBe(400);
  const deleted = await app.inject({ method: 'DELETE', url: '/api/catalog/combinations/worker', headers: { origin, cookie } });
  expect(deleted.statusCode).toBe(200);
  expect(JSON.parse(await readFile(recipesPath, 'utf8')).combinations).toEqual([]);
});

test('the library UI no longer exposes a manual compile action and the catalog always compiles on save', async () => {
  const librarySource = await readFile(join(process.cwd(), 'src/web/ResourceLibrary.tsx'), 'utf8');
  expect(librarySource).not.toContain('void compile(');
  expect(librarySource).not.toContain('/compile');
  expect(librarySource).not.toMatch(/>\s*编译\s*</);
  expect(librarySource).toContain("api<SavedAgentCombination>('/api/catalog/combinations'");

  const catalogSource = await readFile(join(process.cwd(), 'src/catalog/catalog.ts'), 'utf8');
  expect(catalogSource).not.toContain("saved.mode === 'main'");
  expect(catalogSource).toContain('compileError');
});
