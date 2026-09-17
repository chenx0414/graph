import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadResourceCatalog, parseResourceCatalog, resourceDetail, searchResourceCatalog } from '../../src/catalog/resource-catalog.ts';
import { loadAgentCombinations } from '../../src/catalog/agent-combinations.ts';

const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

test('the built-in resource catalog is valid and covers every resource family', async () => {
  const catalog = await loadResourceCatalog(presetsRoot);
  const ids = catalog.entries.map(entry => entry.id);
  expect(new Set(ids).size).toBe(ids.length);
  expect(catalog.entries.filter(entry => entry.kind === 'skill').length).toBeGreaterThanOrEqual(15);
  expect(catalog.entries.filter(entry => entry.kind === 'mcp').length).toBeGreaterThanOrEqual(20);
  expect(catalog.entries.filter(entry => entry.kind === 'pi-extension').length).toBeGreaterThanOrEqual(5);
  expect(catalog.entries.filter(entry => entry.kind === 'agent-md').length).toBeGreaterThanOrEqual(15);
  expect(catalog.entries.find(entry => entry.id === 'mcp-github')).toMatchObject({
    kind: 'mcp',
    source: 'https://github.com/github/github-mcp-server',
    transport: 'streamable-http',
  });
  expect(catalog.entries.find(entry => entry.id === 'mcp-github')?.requirements).toEqual(
    expect.arrayContaining(['远程 OAuth 或 GITHUB_PERSONAL_ACCESS_TOKEN']),
  );
  expect(catalog.entries.find(entry => entry.id === 'pi-mcp-extension')).toMatchObject({
    kind: 'pi-extension',
    source: 'https://pi.dev/packages/pi-mcp-extension',
    compatibility: 'unverified',
  });
  const superpowers = catalog.entries.filter(entry => entry.sourceRepository === 'obra/superpowers-skills');
  expect(superpowers.length).toBeGreaterThan(20);
  expect(superpowers.every(entry => entry.archived === true && entry.resolvedCommit)).toBe(true);
  expect(catalog.entries.find(entry => entry.sourceRepository === 'mcncarl/yichen-skills')).toMatchObject({ commercialUse: 'restricted' });
  expect(catalog.entries.find(entry => entry.kind === 'skill-index')).toMatchObject({ sourceRepository: 'VoltAgent/awesome-agent-skills' });
});

test('resource catalog rejects duplicate ids and unsupported kinds', () => {
  const base = {
    id: 'skill-one',
    kind: 'skill',
    name: 'One',
    description: 'One skill',
    source: 'https://example.test/skill',
    sourceKind: 'github',
  };
  expect(() => parseResourceCatalog({ version: 1, entries: [base, base] })).toThrow(/Duplicate resource id/);
  expect(() => parseResourceCatalog({ version: 1, entries: [{ ...base, kind: 'plugin' }] })).toThrow(/unsupported kind/);
});

test('resource search is bounded, filterable and keeps catalog entries separate from authorization', async () => {
  const catalog = await loadResourceCatalog(presetsRoot);
  const github = searchResourceCatalog(catalog.entries, { query: 'github', kind: 'mcp', limit: 5 });
  expect(github.items.every(entry => entry.kind === 'mcp')).toBe(true);
  expect(github.items.some(entry => entry.id === 'mcp-github')).toBe(true);
  expect(github.limit).toBe(5);
  expect(github.items.length).toBeLessThanOrEqual(5);

  const first = searchResourceCatalog(catalog.entries, { query: 'skill', limit: 3, offset: 0 });
  const second = searchResourceCatalog(catalog.entries, { query: 'skill', limit: 3, offset: 3 });
  expect(first.items.map(entry => entry.id)).not.toEqual(second.items.map(entry => entry.id));
  expect(first.hasMore).toBe(true);

  const detail = resourceDetail(catalog.entries.find(entry => entry.id === 'mcp-github')!);
  expect(detail.authorization).toEqual({
    catalogEntryOnly: true,
    notInstalled: true,
    grantsNoPermission: true,
  });
});

test('Agent combinations are recipes over existing resource-library entries', async () => {
  const catalog = await loadResourceCatalog(presetsRoot);
  const combinations = await loadAgentCombinations(presetsRoot, catalog.entries);
  expect(combinations.combinations.map(item => item.id)).toEqual([
    'code', 'test', 'review', 'e2e-test', 'security', 'gate', 'ship',
    'literature-search', 'paper-writing', 'paper-polish',
  ]);
  const review = combinations.combinations.find(item => item.id === 'review')!;
  expect(review).toMatchObject({ recommendedGrade: 'high', review: true });
  expect(review.resources).toEqual(expect.arrayContaining([
    expect.objectContaining({ resourceId: 'agent-md-code-reviewer', role: 'identity' }),
  ]));
  const known = new Set(catalog.entries.map(item => item.id));
  expect(combinations.combinations.flatMap(item => item.resources).every(item => known.has(item.resourceId))).toBe(true);
});
