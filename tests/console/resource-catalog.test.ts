import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { loadResourceCatalog, parseResourceCatalog } from '../../src/catalog/resource-catalog.ts';

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
  expect(catalog.entries.find(entry => entry.id === 'skill-superpowers')).toMatchObject({ archived: true });
  expect(catalog.entries.find(entry => entry.id === 'skill-yichen')).toMatchObject({ commercialUse: 'restricted' });
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
