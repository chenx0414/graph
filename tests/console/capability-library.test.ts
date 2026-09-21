import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CapabilityLibrary } from '../../src/catalog/capability-library.ts';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore } from '../../src/core/store.ts';
import { loadCapabilities } from '../../src/runtime/capabilities.ts';
import { graphNodeRuntime } from '../../src/runtime/workspace-command.ts';

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

test('the writable capability bundle path installs MCP manifests and rejects unsafe files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-bundle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const library = new CapabilityLibrary({ capabilityRoot: root });
  await library.refresh();

  const installed = await library.upsertCapabilityBundle({
    manifest: {
      id: 'semantic-scholar',
      kind: 'mcp',
      version: '1.0.0',
      name: 'Semantic Scholar',
      command: 'uvx',
      args: ['semantic-scholar-mcp'],
      networkDomains: ['api.semanticscholar.org'],
    },
  });
  expect(installed.capability).toMatchObject({
    id: 'semantic-scholar',
    kind: 'mcp',
    version: '1.0.0',
    status: 'available',
  });
  expect(library.capability('semantic-scholar')).toMatchObject({ status: 'available' });

  await expect(library.upsertCapabilityBundle({
    manifest: {
      id: 'unsafe',
      kind: 'skill',
      version: '1.0.0',
      name: 'Unsafe',
    },
    files: { '../escape.md': 'no' },
  })).rejects.toThrow(/relative|traverse/);
  await expect(library.upsertCapabilityBundle({
    manifest: {
      id: 'manifest-override',
      kind: 'mcp',
      version: '1.0.0',
      name: 'Manifest override',
      command: 'node',
      args: ['server.mjs'],
    },
    files: { './capability.json': '{}' },
  })).rejects.toThrow(/generated from the manifest/);
  await expect(library.upsertCapabilityBundle({
    manifest: {
      id: 'literal-secret',
      kind: 'mcp',
      version: '1.0.0',
      name: 'Literal secret',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer plaintext' },
    },
  })).rejects.toThrow(/credential headers/);
  await expect(library.upsertCapabilityBundle({
    manifest: {
      id: 'invalid-mcp',
      kind: 'mcp',
      version: '1.0.0',
      name: 'Invalid MCP',
    },
  })).rejects.toThrow(/command or url/);
  expect(existsSync(join(root, 'mcp', 'invalid-mcp-1.0.0'))).toBe(false);
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

test('MCP provisioning keeps installer domains separate from runtime network', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-provisioning-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await capability(root, 'valid', {
    id: 'valid', kind: 'mcp', version: '1.0.0', name: 'Valid', command: 'uvx',
    provisioning: { manager: 'uv', domains: ['downloads.example.test', '${PROVISION_TOKEN_HOST}'] },
    networkDomains: ['api.example.test'],
  });
  await capability(root, 'mismatch', {
    id: 'mismatch', kind: 'mcp', version: '1.0.0', name: 'Mismatch', command: 'uvx',
    provisioning: { manager: 'npm' },
  });
  await capability(root, 'unsupported', {
    id: 'unsupported', kind: 'mcp', version: '1.0.0', name: 'Unsupported', command: 'node',
    provisioning: { domains: ['downloads.example.test'] },
  });

  const library = new CapabilityLibrary({ capabilityRoot: root });
  await library.refresh();
  expect(library.capabilities()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'valid', status: 'available' }),
    expect.objectContaining({ id: 'mismatch', status: 'invalid', error: expect.stringContaining('does not match command') }),
    expect.objectContaining({ id: 'unsupported', status: 'invalid', error: expect.stringContaining('only valid for local uvx or npx') }),
  ]));
});

test('Pi extension runtime declarations are validated separately from MCP network fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await capability(root, 'runtime', {
    id: 'runtime',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Runtime',
    entry: './index.mjs',
    runtime: {
      commands: ['node'],
      env: { GRAPH_RUNTIME_MARKER: 'ok' },
      networkAccess: 'unrestricted',
      allowLocalBinding: true,
      unixSockets: ['/private/tmp/graph-runtime-${uid}'],
    },
  }, { 'index.mjs': 'export default () => {};\n' });
  await capability(root, 'bad-runtime', {
    id: 'bad-runtime',
    kind: 'skill',
    version: '1.0.0',
    name: 'Bad runtime',
    runtime: { commands: ['node'] },
  }, { 'SKILL.md': '# Bad runtime\n' });
  await capability(root, 'bad-network', {
    id: 'bad-network',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Bad network',
    entry: './index.mjs',
    runtime: { networkAccess: 'unrestricted', networkDomains: ['example.test'] },
  }, { 'index.mjs': 'export default () => {};\n' });

  const library = new CapabilityLibrary({ capabilityRoot: root });
  await library.refresh();
  expect(library.capabilities()).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'runtime', status: 'available' }),
    expect.objectContaining({ id: 'bad-runtime', status: 'invalid', error: expect.stringContaining('only valid for Pi extensions') }),
    expect.objectContaining({ id: 'bad-network', status: 'invalid', error: expect.stringContaining('cannot combine') }),
  ]));
});

test('Pi extension runtime materializes writable roots but leaves read-only paths untouched', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-runtime-load-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  await capability(capabilityRoot, 'runtime', {
    id: 'runtime',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Runtime',
    entry: './index.mjs',
    runtime: {
      commands: ['node'],
      readPaths: ['${scratchDir}/read-only'],
      writePaths: ['${scratchDir}/writable'],
    },
  }, { 'index.mjs': 'export default () => {};\n' });

  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot, recipesPath: join(root, 'agent-combinations.json') });
  await catalog.refresh();
  catalog.publishDefinition('master', {
    recommendedGrade: 'high',
    capabilities: [{ id: 'runtime', version: '1.0.0' }],
  });
  const scratchDir = join(root, 'scratch');
  const loaded = await loadCapabilities({
    catalog,
    definitionVersion: 'master@1',
    workspace: root,
    scratchDir,
    gate: { dispatch: (_id, _reservation, send) => send(), settle: () => undefined },
  });
  cleanup.push(() => loaded.close());

  expect(existsSync(join(scratchDir, 'read-only'))).toBe(false);
  expect(existsSync(join(scratchDir, 'writable'))).toBe(true);
  expect(loaded.readRoots).toContain(join(scratchDir, 'read-only'));
  expect(loaded.env.PATH).toContain(dirname(graphNodeRuntime().execPath));
});

test('Pi extension runtime commands resolve from common user bin directories when the app PATH is minimal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-runtime-path-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const userBin = join(root, '.local', 'bin');
  const targetBin = join(root, 'tool', 'bin');
  const command = 'graph-extension-fixture';
  await Promise.all([mkdir(userBin, { recursive: true }), mkdir(targetBin, { recursive: true })]);
  await writeFile(join(targetBin, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await symlink(join(targetBin, command), join(userBin, command));
  await capability(capabilityRoot, 'runtime-path', {
    id: 'runtime-path',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Runtime path',
    entry: './index.mjs',
    runtime: { commands: [command] },
  }, { 'index.mjs': 'export default () => {};\n' });

  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot, recipesPath: join(root, 'agent-combinations.json') });
  await catalog.refresh();
  catalog.publishDefinition('master', {
    recommendedGrade: 'high',
    capabilities: [{ id: 'runtime-path', version: '1.0.0' }],
  });

  const originalPath = process.env.PATH;
  const originalHome = process.env.HOME;
  process.env.PATH = '/usr/bin:/bin';
  process.env.HOME = root;
  try {
    const loaded = await loadCapabilities({
      catalog,
      definitionVersion: 'master@1',
      workspace: root,
      scratchDir: join(root, 'scratch'),
      gate: { dispatch: (_id, _reservation, send) => send(), settle: () => undefined },
    });
    try {
      expect(loaded.env.PATH).toContain(userBin);
      expect(loaded.readRoots).toContain(userBin);
      expect(loaded.readRoots).toContain(await realpath(targetBin));
    } finally {
      await loaded.close();
    }
  } finally {
    process.env.PATH = originalPath;
    process.env.HOME = originalHome;
  }
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
    snapshot: { agentCombination: { id: 'review', name: 'Review', description: 'Review work.' } },
  });
  const updated = await library.updateAgentCombinationDescription('review', 'Independently review implementation evidence and report actionable defects.');
  expect(updated).toMatchObject({
    id: 'review',
    description: 'Independently review implementation evidence and report actionable defects.',
  });
  expect(library.compileAgentCombination('review').definition).toMatchObject({
    snapshot: {
      agentCombination: {
        id: 'review',
        description: 'Independently review implementation evidence and report actionable defects.',
      },
    },
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

test('catalog publishes a new version when a recipe rolls back to a historical definition', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-catalog-rollback-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store);

  const first = catalog.ensureDefinition('main', { recommendedGrade: 'high' });
  const second = catalog.ensureDefinition('main', { recommendedGrade: 'medium' });
  const rollback = catalog.ensureDefinition('main', { recommendedGrade: 'high' });

  expect([first.key, second.key, rollback.key]).toEqual([
    'main@1',
    'main@2',
    'main@3',
  ]);
  expect(catalog.listDefinitions()).toContainEqual({ id: 'main', version: 3 });
  expect(catalog.definition('main@3')).toMatchObject({ id: 'main', version: 3, recommendedGrade: 'high' });
  expect(catalog.ensureDefinition('main', { recommendedGrade: 'high' }).key).toBe('main@3');
});
