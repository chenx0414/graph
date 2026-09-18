import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CapabilityLibrary } from '../../src/catalog/capability-library.ts';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function capability(root: string, directory: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'capability.json'), JSON.stringify(manifest, null, 2));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), body);
  }
}

test('filesystem capabilities are scanned recursively and invalid manifests stay visible', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-library-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await capability(root, 'skills/research', { id: 'research', kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  await capability(root, 'mcp/github', { id: 'github', kind: 'mcp', version: '2.0.0', name: 'GitHub', url: 'https://example.test/mcp' });
  await capability(root, 'prompts/reviewer', { id: 'reviewer', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Reviewer' }, { 'agent.md': 'Review carefully.\n' });
  await capability(root, 'broken', { id: 'broken', kind: 'skill', version: '1.0.0', name: 'Broken' });

  const library = new CapabilityLibrary({ capabilityRoot: root });
  await library.refresh();
  expect(library.capabilities()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'research', status: 'available', kind: 'skill' }),
    expect.objectContaining({ id: 'github', status: 'available', kind: 'mcp' }),
    expect.objectContaining({ id: 'reviewer', status: 'available', kind: 'prompt', role: 'agent' }),
    expect.objectContaining({ id: 'broken', status: 'invalid', error: expect.stringContaining('SKILL.md') }),
  ]));
});

test('MCP network declarations accept host patterns and environment references but reject URLs and wildcard-all', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-network-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await capability(root, 'valid', {
    id: 'valid', kind: 'mcp', version: '1.0.0', name: 'Valid', command: 'node',
    networkDomains: ['api.github.com', '*.example.test', '${EXA_BASE_URL}'],
  });
  await capability(root, 'browser', {
    id: 'browser', kind: 'mcp', version: '1.0.0', name: 'Browser', command: 'node',
    networkAccess: 'unrestricted',
  });
  await capability(root, 'url', {
    id: 'url', kind: 'mcp', version: '1.0.0', name: 'URL', command: 'node',
    networkDomains: ['https://api.example.test'],
  });
  await capability(root, 'all', {
    id: 'all', kind: 'mcp', version: '1.0.0', name: 'All', command: 'node',
    networkDomains: ['*'],
  });
  await capability(root, 'skill', {
    id: 'skill', kind: 'skill', version: '1.0.0', name: 'Skill', networkDomains: ['api.example.test'],
  }, { 'SKILL.md': '# Skill\n' });

  const library = new CapabilityLibrary({ capabilityRoot: root });
  await library.refresh();
  expect(library.capabilities()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'valid', status: 'available' }),
    expect.objectContaining({ id: 'browser', status: 'available' }),
    expect.objectContaining({ id: 'url', status: 'invalid', error: expect.stringContaining('networkDomains') }),
    expect.objectContaining({ id: 'all', status: 'invalid', error: expect.stringContaining('networkDomains') }),
    expect.objectContaining({ id: 'skill', status: 'invalid', error: expect.stringContaining('only valid for MCP') }),
  ]));
});

test('recipes validate against the current capability projection and compile to a versioned definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-recipes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const recipesPath = join(root, 'agent-combinations.json');
  await capability(capabilityRoot, 'identity', { id: 'identity', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Identity' }, { 'agent.md': 'Identity.\n' });
  await capability(capabilityRoot, 'research', { id: 'research', kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  const library = new CapabilityLibrary({ capabilityRoot, recipesPath });
  await library.refresh();

  const view = await library.saveAgentCombination({
    id: 'review',
    name: 'Review',
    description: 'Review work.',
    recommendedGrade: 'high',
    review: true,
    tags: ['review'],
    resources: [
      { resourceId: 'identity', version: '1.0.0', role: 'identity', required: true },
      { resourceId: 'research', version: '1.0.0', role: 'skill', required: true },
    ],
  });
  expect(view).toMatchObject({ status: 'valid', issues: [] });
  expect(library.agentCombinations()).toHaveLength(1);
  expect(library.searchAgentCombinations({ query: 'review' }).items).toEqual([expect.objectContaining({ id: 'review' })]);
  const compiled = library.compileAgentCombination('review');
  expect(compiled.definition).toMatchObject({
    recommendedGrade: 'high',
    review: true,
    capabilities: [{ id: 'research', version: '1.0.0' }],
    prompts: { agent: { id: 'identity', version: '1.0.0' } },
  });
});

test('the Main Agent recipe may start empty, compiles as main, and cannot be deleted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-main-recipe-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const library = new CapabilityLibrary({
    capabilityRoot: join(root, 'capabilities'),
    recipesPath: join(root, 'agent-combinations.json'),
  });
  await library.refresh();
  const saved = await library.saveAgentCombination({
    id: 'main',
    name: 'Main Agent',
    description: 'Continue-facing orchestration agent.',
    mode: 'main',
    recommendedGrade: 'high',
    review: false,
    tags: ['main'],
    resources: [],
  });
  expect(saved).toMatchObject({ id: 'main', mode: 'main', status: 'valid', resources: [] });
  const compiled = library.compileAgentCombination('main');
  expect(compiled.definition).toMatchObject({
    recommendedGrade: 'high',
    snapshot: { agentCombination: { id: 'main', mode: 'main' } },
  });
  expect(compiled.definition.capabilities).toBeUndefined();
  await expect(library.deleteAgentCombination('main')).rejects.toThrow(/cannot be deleted/);
});

test('catalog composes the capability library and persists recipe compilation only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-catalog-recipes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  await capability(capabilityRoot, 'skill', { id: 'skill', kind: 'skill', version: '1.0.0', name: 'Skill' }, { 'SKILL.md': '# Skill\n' });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot, recipesPath: join(root, 'agent-combinations.json') });
  await catalog.refresh();
  await catalog.saveAgentCombination({
    id: 'worker',
    name: 'Worker',
    description: 'Use one skill.',
    recommendedGrade: 'medium',
    review: false,
    tags: ['worker'],
    resources: [{ resourceId: 'skill', version: '1.0.0', role: 'skill', required: true }],
  });
  const first = catalog.compileAgentCombination('worker');
  const second = catalog.compileAgentCombination('worker');
  expect(first.definitionVersion).toBe('worker@1');
  expect(second.version).toBe(first.version);
  expect(catalog.agentCombinations()).toHaveLength(1);
  catalog.publishDefinition('retired', { recommendedGrade: 'medium' });
  expect(catalog.availableAgentDefinitions()).toEqual([{ id: 'worker', version: first.version }]);
  await catalog.deleteAgentCombination('worker');
  expect(catalog.agentCombinations()).toEqual([]);
  expect(catalog.availableAgentDefinitions()).toEqual([]);
});
