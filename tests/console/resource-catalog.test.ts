import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { scanCapabilities } from '../../src/catalog/file-capabilities.ts';
import {
  compileAgentCombinationDefinition,
  parseAgentCombinations,
  validateAgentCombination,
} from '../../src/catalog/agent-combinations.ts';
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
  const root = await mkdtemp(join(tmpdir(), 'graph-capabilities-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await capability(root, 'skills/research', { id: 'research', kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  await capability(root, 'mcp/github', { id: 'github', kind: 'mcp', version: '2.0.0', name: 'GitHub', url: 'https://example.test/mcp' });
  await capability(root, 'prompts/reviewer', { id: 'reviewer', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Reviewer' }, { 'agent.md': 'Review carefully.\n' });
  await capability(root, 'broken', { id: 'broken', kind: 'skill', version: '1.0.0', name: 'Broken' });

  const records = await scanCapabilities(root);
  expect(records).toEqual(expect.arrayContaining([
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

  const records = await scanCapabilities(root);
  expect(records).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'valid', status: 'available' }),
    expect.objectContaining({ id: 'browser', status: 'available' }),
    expect.objectContaining({ id: 'url', status: 'invalid', error: expect.stringContaining('networkDomains') }),
    expect.objectContaining({ id: 'all', status: 'invalid', error: expect.stringContaining('networkDomains') }),
    expect.objectContaining({ id: 'skill', status: 'invalid', error: expect.stringContaining('only valid for MCP') }),
  ]));
});

test('recipes validate against scanned capabilities and compile to a versioned definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-recipes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilitiesRoot = join(root, 'capabilities');
  await capability(capabilitiesRoot, 'identity', { id: 'identity', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Identity' }, { 'agent.md': 'Identity.\n' });
  await capability(capabilitiesRoot, 'research', { id: 'research', kind: 'skill', version: '1.0.0', name: 'Research' }, { 'SKILL.md': '# Research\n' });
  const records = await scanCapabilities(capabilitiesRoot);
  const document = parseAgentCombinations({
    version: 1,
    combinations: [{
      id: 'review',
      name: 'Review',
      description: 'Review work.',
      recommendedGrade: 'high',
      review: true,
      resources: [
        { resourceId: 'identity', version: '1.0.0', role: 'identity' },
        { resourceId: 'research', version: '1.0.0', role: 'skill' },
      ],
    }],
  });
  const view = validateAgentCombination(document.combinations[0]!, records);
  expect(view).toMatchObject({ status: 'valid', issues: [] });
  const compiled = compileAgentCombinationDefinition(document.combinations[0]!, records);
  expect(compiled.definition).toMatchObject({
    recommendedGrade: 'high',
    review: true,
    capabilities: [{ id: 'research', version: '1.0.0' }],
    prompts: { agent: { id: 'identity', version: '1.0.0' } },
  });
});

test('Catalog persists recipe CRUD and compiles the same definition only once', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-catalog-recipes-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilitiesRoot = join(root, 'capabilities');
  await capability(capabilitiesRoot, 'skill', { id: 'skill', kind: 'skill', version: '1.0.0', name: 'Skill' }, { 'SKILL.md': '# Skill\n' });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot: capabilitiesRoot, recipesPath: join(root, 'agent-combinations.json') });
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
  await catalog.deleteAgentCombination('worker');
  expect(catalog.agentCombinations()).toEqual([]);
});
