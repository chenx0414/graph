import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { resolveCapabilityFacts } from '../../src/runtime/capabilities.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'graph-base-capability-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  return { root, capabilityRoot, store, catalog: new Catalog(store, { capabilityRoot }) };
}

async function capability(capabilityRoot: string, directory: string, manifest: Record<string, unknown>) {
  const path = join(capabilityRoot, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'capability.json'), canonicalJson(manifest));
}

test('a base capability reaches a definition that never binds it', async () => {
  const { capabilityRoot, catalog } = await project();
  await capability(capabilityRoot, 'skills/read-skill', { id: 'read-skill', kind: 'skill', version: '1.0.0', name: 'Read skill' });
  await writeFile(join(capabilityRoot, 'skills/read-skill/SKILL.md'), '# Read\n\nRead the project first.\n');
  await capability(capabilityRoot, 'pi-extensions/mcp-adapter', {
    id: 'mcp-adapter', kind: 'pi-extension', version: '2.37.0', name: 'Pi MCP Adapter',
    source: 'npm:pi-mcp-adapter@^2.37.0', base: true,
    tools: [{ name: 'mcp', description: 'Gateway to MCP servers.' }],
  });
  await catalog.refresh();
  catalog.publishDefinition('plain', { recommendedGrade: 'medium', capabilities: [{ id: 'read-skill', version: '1.0.0' }] });

  const facts = await resolveCapabilityFacts(catalog, 'plain@1');
  expect(facts.map(fact => fact.id).sort()).toEqual(['mcp-adapter', 'read-skill']);
});

test('a capability without the base flag is not forced onto a definition', async () => {
  const { capabilityRoot, catalog } = await project();
  await capability(capabilityRoot, 'pi-extensions/optional', {
    id: 'optional', kind: 'pi-extension', version: '1.0.0', name: 'Optional',
    entry: './index.mjs', tools: [{ name: 'optional_tool', description: 'Optional.' }],
  });
  await writeFile(join(capabilityRoot, 'pi-extensions/optional/index.mjs'), 'export default function () {}\n');
  await catalog.refresh();
  catalog.publishDefinition('plain', { recommendedGrade: 'medium', capabilities: [] });

  expect(await resolveCapabilityFacts(catalog, 'plain@1')).toEqual([]);
});

test('an explicit binding of a base capability is not duplicated', async () => {
  const { capabilityRoot, catalog } = await project();
  await capability(capabilityRoot, 'pi-extensions/mcp-adapter', {
    id: 'mcp-adapter', kind: 'pi-extension', version: '2.37.0', name: 'Pi MCP Adapter',
    source: 'npm:pi-mcp-adapter@^2.37.0', base: true,
    tools: [{ name: 'mcp', description: 'Gateway to MCP servers.' }],
  });
  await catalog.refresh();
  catalog.publishDefinition('bound', { recommendedGrade: 'medium', capabilities: [{ id: 'mcp-adapter', version: '2.37.0' }] });

  const facts = await resolveCapabilityFacts(catalog, 'bound@1');
  expect(facts.filter(fact => fact.id === 'mcp-adapter')).toHaveLength(1);
});
