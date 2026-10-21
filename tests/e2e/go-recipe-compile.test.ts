import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The recipe library of the Go daemon.
 *
 * A recipe is the user's own description of an Agent: which capability it
 * binds, what grade of model it wants, and - when it binds nothing - the
 * system prompt that stands for its identity. The library only means something
 * if the identity behind it is real, so saving a recipe has to compile it and
 * publish the result at once - a recipe the console shows while no definition
 * can run it is a promise the runtime never keeps. A recipe that names a
 * capability nobody installed has to be refused instead of saved, and it must
 * not leave a half-written file behind.
 *
 * The proof is the real Go process over real HTTP: the capability on disk, the
 * recipe file the daemon wrote, the definitions it published, and the prompt
 * the provider was really asked with.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface Recipe {
  id: string;
  name: string;
  description: string;
  recommendedGrade: string;
  review: boolean;
  tags: string[];
  resources: { resourceId: string; version: string; role: string; required: boolean }[];
}

interface CombinationView {
  id: string;
  status: string;
  description: string;
  mode?: string;
}

interface CompiledDefinition {
  definitionVersion: string;
  version: number;
}

interface SavedView {
  combination: CombinationView;
  definition?: CompiledDefinition;
  compileError?: string;
}

interface CatalogView {
  definitions: { id: string; version: number }[];
  agentCombinations: CombinationView[];
}

interface ErrorView {
  code?: string;
  message?: string;
}

/** A recipe that binds the one capability the fixture installed. */
function workerRecipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: 'worker',
    name: 'Worker',
    description: 'Use one skill.',
    recommendedGrade: 'frontier',
    review: false,
    tags: ['worker'],
    resources: [{ resourceId: 'research', version: '1.0.0', role: 'skill', required: true }],
    ...overrides,
  };
}

async function fixture(prefix: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-e2e-go-recipe-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The capability the recipe binds: a real skill the library can resolve.
  const graphHome = join(root, 'graph-home');
  const capability = join(graphHome, 'capabilities', 'research');
  await mkdir(capability, { recursive: true });
  await writeFile(join(capability, 'capability.json'), JSON.stringify({
    id: 'research', kind: 'skill', version: '1.0.0', name: 'Research',
  }));
  await writeFile(join(capability, 'SKILL.md'), '# Research\n\nRead before you answer.\n');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }] }));
  const daemon = await launchCli(root, { configPath });
  cleanup.push(() => daemon.close());
  const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const response = await daemon.request(path, init);
    const body = await response.json().catch(() => ({})) as T;
    return { status: response.status, body };
  };
  return { root, graphHome, recipesPath: join(graphHome, 'agent-combinations.json'), request };
}

/**
 * A daemon with a real model behind it, running on the Go kernel.
 *
 * The Go kernel is the one that composes the prompt and sends the request
 * itself, so what the provider receives is what Go put together - not a
 * TypeScript sidecar's rendering of it.
 */
async function modelFixture(prefix: string) {
  const provider = await openaiServer(Array.from({ length: 8 }, () => ({ text: 'Working on it.' })));
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), `graph-e2e-go-recipe-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const graphHome = join(root, 'graph-home');
  await mkdir(graphHome, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_LOCAL_KEY: 'key-local' }, extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const response = await daemon.request(path, init);
    const body = await response.json().catch(() => ({})) as T;
    return { status: response.status, body };
  };
  return { root, graphHome, recipesPath: join(graphHome, 'agent-combinations.json'), provider, request };
}

test('saving a recipe compiles it at once and publishes the definition behind it', async () => {
  const f = await fixture('compile');

  const saved = await f.request<SavedView>('/api/catalog/combinations', {
    method: 'POST', body: JSON.stringify({ combination: workerRecipe() }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.combination.id).toBe('worker');
  expect(saved.body.combination.status).toBe('valid');
  expect(saved.body.combination.mode).toBeUndefined();
  expect(saved.body.definition?.definitionVersion).toBe('worker@1');
  expect(saved.body.definition?.version).toBe(1);

  // The library shows the recipe and the definition it published.
  const catalog = await f.request<CatalogView>('/api/catalog');
  expect(catalog.status).toBe(200);
  expect(catalog.body.definitions.filter(item => item.id === 'worker')).toEqual([{ id: 'worker', version: 1 }]);
  expect(catalog.body.agentCombinations.filter(item => item.id === 'worker').map(item => item.status)).toEqual(['valid']);

  // Saving the same recipe again reuses the published definition instead of versioning it twice.
  const again = await f.request<SavedView>('/api/catalog/combinations', {
    method: 'POST', body: JSON.stringify({ combination: workerRecipe() }),
  });
  expect(again.status, JSON.stringify(again.body)).toBe(200);
  expect(again.body.definition?.definitionVersion).toBe('worker@1');
  expect(again.body.definition?.version).toBe(1);
  const unchanged = await f.request<CatalogView>('/api/catalog');
  expect(unchanged.body.definitions.filter(item => item.id === 'worker')).toEqual([{ id: 'worker', version: 1 }]);

  // A recipe that names a capability nobody installed is refused, and it never lands.
  const refused = await f.request<ErrorView>('/api/catalog/combinations', {
    method: 'POST', body: JSON.stringify({ combination: workerRecipe({
      id: 'ghost',
      resources: [{ resourceId: 'missing-capability', version: '1.0.0', role: 'skill', required: true }],
    }) }),
  });
  expect(refused.status).toBe(400);
  expect(refused.body.message).toContain('Missing required capability missing-capability@1.0.0');
  const afterRefusal = await f.request<CatalogView>('/api/catalog');
  expect(afterRefusal.body.agentCombinations.map(item => item.id)).not.toContain('ghost');
  expect(afterRefusal.body.definitions.filter(item => item.id === 'ghost')).toEqual([]);

  // The compile endpoint stays available for a console that still calls it.
  const compiled = await f.request<CompiledDefinition>('/api/catalog/combinations/worker/compile', {
    method: 'POST', body: JSON.stringify({}),
  });
  expect(compiled.status, JSON.stringify(compiled.body)).toBe(200);
  expect(compiled.body.definitionVersion).toBe('worker@1');
}, 60_000);

test('the description and delete endpoints change the recipe through the same door the console uses', async () => {
  const f = await fixture('lifecycle');

  const saved = await f.request<SavedView>('/api/catalog/combinations', {
    method: 'POST', body: JSON.stringify({ combination: workerRecipe() }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);

  // Editing the description is a save of the same recipe, so the definition behind it moves too.
  const described = await f.request<{ combination: CombinationView; definition: CompiledDefinition }>(
    '/api/catalog/combinations/worker/description',
    { method: 'POST', body: JSON.stringify({ description: '把一件事做完。' }) },
  );
  expect(described.status, JSON.stringify(described.body)).toBe(200);
  expect(described.body.combination.description).toBe('把一件事做完。');
  expect(described.body.definition.definitionVersion).toBe('worker@2');
  expect(described.body.definition.version).toBe(2);

  // The recipe file on disk carries the same description.
  const document = JSON.parse(await readFile(f.recipesPath, 'utf8')) as {
    combinations: { id: string; description: string }[];
  };
  expect(document.combinations.find(item => item.id === 'worker')?.description).toBe('把一件事做完。');

  const catalog = await f.request<CatalogView>('/api/catalog');
  expect(catalog.body.definitions.filter(item => item.id === 'worker')).toEqual([{ id: 'worker', version: 2 }]);

  // Deleting takes the recipe away; the Main Agent recipe the daemon wrote stays.
  const deleted = await f.request<{ id: string; deleted: boolean }>('/api/catalog/combinations/worker', {
    method: 'DELETE',
  });
  expect(deleted.status, JSON.stringify(deleted.body)).toBe(200);
  expect(deleted.body).toEqual({ id: 'worker', deleted: true });

  const afterDelete = JSON.parse(await readFile(f.recipesPath, 'utf8')) as { combinations: { id: string }[] };
  expect(afterDelete.combinations.map(item => item.id)).toEqual(['main']);

  const catalogAfter = await f.request<CatalogView>('/api/catalog');
  expect(catalogAfter.body.agentCombinations.map(item => item.id)).not.toContain('worker');
}, 60_000);

test('an inline recipe prompt is versioned and reaches the next Agent operation', async () => {
  const f = await modelFixture('inline-prompt');

  // The Main Agent recipe carries an inline system prompt instead of a bound capability.
  const saved = await f.request<SavedView>('/api/catalog/combinations', {
    method: 'POST', body: JSON.stringify({ combination: {
      id: 'main', name: 'Atlas_main', description: '持续面对用户、规划任务。', mode: 'main',
      recommendedGrade: 'high', review: false, tags: ['main', 'system'],
      systemPrompt: 'You are a climate data specialist.', resources: [],
    } }),
  });
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.definition?.definitionVersion).toBe('main@2');
  expect(saved.body.definition?.version).toBe(2);

  // The next operation really carries it: the provider is asked with that prompt.
  const created = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Who are you?', requestId: 'inline-prompt' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);

  await expect.poll(() => f.provider.requests.length, { timeout: 60_000, interval: 250 }).toBeGreaterThan(0);
  const first = f.provider.requests[0] as { messages?: { role?: string; content?: unknown }[] };
  // The leading message of the transcript is the instruction: the role is the one
  // Go picked for this provider, and the text is the identity the recipe carries.
  const instruction = (first.messages ?? [])[0];
  expect(['developer', 'system']).toContain(instruction?.role);
  expect(String(instruction?.content ?? ''), JSON.stringify(first.messages)).toContain('You are a climate data specialist.');
}, 180_000);
