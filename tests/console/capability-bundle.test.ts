import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { openCapabilityBundle } from '../../src/runtime/capability-bundle.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function capability(root: string, directory: string, manifest: Record<string, unknown>, files: Record<string, string> = {}) {
  const path = join(root, directory);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'capability.json'), JSON.stringify(manifest));
  for (const [name, body] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), body);
  }
}

test('a definition version resolves Skills, Pi extensions and agent/tool prompts as one bundle', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-bundle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const capabilityRoot = join(root, 'capabilities');
  const skill = join(capabilityRoot, 'skill');
  const extension = join(capabilityRoot, 'pi-extension');
  const agentPrompt = join(capabilityRoot, 'identity');
  const toolPrompt = join(capabilityRoot, 'awareness');
  await Promise.all([workspace, skill, extension, agentPrompt, toolPrompt].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(skill, 'SKILL.md'), '# Skill\n\nRead the project before editing.\n');
  await writeFile(join(skill, 'capability.json'), canonicalJson({ id: 'skill-read', kind: 'skill', version: '1.0.0', name: 'Read skill' }));
  await writeFile(join(extension, 'capability.json'), canonicalJson({
    id: 'pi-probe',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Probe extension',
    entry: './index.ts',
    tools: [{ name: 'extension_probe', description: 'Probe the extension.' }],
  }));
  await writeFile(join(extension, 'index.ts'), 'export default function () {}\n');
  await writeFile(join(agentPrompt, 'agent.md'), 'You are the bundle test Agent.');
  await writeFile(join(agentPrompt, 'capability.json'), canonicalJson({ id: 'prompt-identity', kind: 'prompt', role: 'agent', version: '1.0.0', name: 'Identity' }));
  await writeFile(join(toolPrompt, 'tool.md'), 'Use only the declared capability bundle.');
  await writeFile(join(toolPrompt, 'capability.json'), canonicalJson({ id: 'prompt-awareness', kind: 'prompt', role: 'tool', version: '1.0.0', name: 'Awareness' }));

  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('bundle-agent', {
    recommendedGrade: 'medium',
    capabilities: [
      { id: 'skill-read', version: '1.0.0' },
      { id: 'pi-probe', version: '1.0.0' },
    ],
    prompts: {
      agent: { id: 'prompt-identity', version: '1.0.0' },
      tool: { id: 'prompt-awareness', version: '1.0.0' },
    },
  });

  const gate = new CallBroker(join(root, 'calls.sqlite'), 'bundle-agent');
  cleanup.push(() => gate.close());
  const bundle = await openCapabilityBundle({
    catalog,
    definitionVersion: 'bundle-agent@1',
    bootstrap: {
      agent: 'You are the bundle test Agent.',
      tool: 'Use only the declared capability bundle.',
    },
  });
  const first = await bundle.openOperation({
    workspace,
    scratchDir: join(root, 'scratch'),
    gate,
    action: 'work',
    hostTools: () => [],
  });
  const second = await bundle.openOperation({
    workspace,
    scratchDir: join(root, 'scratch-2'),
    gate,
    action: 'work',
    readOnly: true,
    grants: ['mcp:example:read'],
    hostTools: () => [],
  });
  try {
    expect(first.skillPaths).toEqual([await realpath(skill)]);
    expect(first.piExtensionPaths).toEqual([join(await realpath(extension), 'index.ts')]);
    expect(first.piExtensionTools).toEqual(['extension_probe']);
    expect(first.prompts.system).toBe('You are the bundle test Agent.');
    expect(first.prompts.tool).toContain('Use only the declared capability bundle.');
    expect(first.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill-read', kind: 'skill', loaded: true }),
      expect.objectContaining({ id: 'pi-probe', kind: 'pi-extension', loaded: true, tools: ['extension_probe'] }),
      expect.objectContaining({ id: 'prompt-identity', kind: 'prompt', loaded: true }),
      expect.objectContaining({ id: 'prompt-awareness', kind: 'prompt', loaded: true }),
    ]));
    expect(first.bundleDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.toolPolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(first.runtimePolicyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(second.bundleDigest).toBe(first.bundleDigest);
    expect(second.toolPolicyDigest).not.toBe(first.toolPolicyDigest);
    expect(second.runtimePolicyDigest).not.toBe(first.runtimePolicyDigest);
  } finally {
    await first.close();
    await second.close();
  }
});

test('a bound MCP capability becomes an adapter server and adds the gateway tool to the allowlist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-mcp-adapter-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const capabilityRoot = join(root, 'capabilities');
  const docs = join(capabilityRoot, 'cloudflare-docs');
  await Promise.all([workspace, docs].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(docs, 'capability.json'), canonicalJson({
    id: 'cloudflare-docs', kind: 'mcp', version: '1.0.0', name: 'Cloudflare docs',
    url: 'https://docs.mcp.cloudflare.com/mcp',
  }));

  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('mcp-agent', { recommendedGrade: 'medium', capabilities: [{ id: 'cloudflare-docs', version: '1.0.0' }] });

  const gate = new CallBroker(join(root, 'calls.sqlite'), 'mcp-agent');
  cleanup.push(() => gate.close());
  const bundle = await openCapabilityBundle({ catalog, definitionVersion: 'mcp-agent@1' });
  const operation = await bundle.openOperation({ workspace, scratchDir: join(root, 'scratch'), gate, action: 'work', hostTools: () => [] });
  try {
    expect(operation.mcpAdapterServers).toEqual([
      { name: 'cloudflare-docs', definition: { url: 'https://docs.mcp.cloudflare.com/mcp' } },
    ]);
    expect(operation.allowedToolNames).toContain('mcp');
  } finally {
    await operation.close();
  }
});

test('a definition without MCP capabilities neither registers a server nor allows the gateway tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-mcp-none-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const capabilityRoot = join(root, 'capabilities');
  const skill = join(capabilityRoot, 'skill');
  await Promise.all([workspace, skill].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(skill, 'SKILL.md'), '# Skill\n\nRead the project before editing.\n');
  await writeFile(join(skill, 'capability.json'), canonicalJson({ id: 'skill-read', kind: 'skill', version: '1.0.0', name: 'Read skill' }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('plain-agent', { recommendedGrade: 'medium', capabilities: [{ id: 'skill-read', version: '1.0.0' }] });
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'plain-agent');
  cleanup.push(() => gate.close());
  const bundle = await openCapabilityBundle({ catalog, definitionVersion: 'plain-agent@1' });
  const operation = await bundle.openOperation({ workspace, scratchDir: join(root, 'scratch'), gate, action: 'work', hostTools: () => [] });
  try {
    expect(operation.mcpAdapterServers).toEqual([]);
    expect(operation.allowedToolNames).not.toContain('mcp');
  } finally {
    await operation.close();
  }
});

test('disabled tools are removed from the operation, allowlist and generated prompt', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const capabilityRoot = join(root, 'capabilities');
  await mkdir(workspace, { recursive: true });
  await capability(capabilityRoot, 'extension', {
    id: 'pi-probe',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Probe',
    entry: './index.ts',
    tools: [{ name: 'extension_probe', description: 'Probe.' }],
  }, { 'index.ts': 'export default function () {}\n' });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('worker', {
    recommendedGrade: 'medium',
    capabilities: [{ id: 'pi-probe', version: '1.0.0' }],
  });
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'worker');
  cleanup.push(() => gate.close());
  const hostTool: ToolDefinition = {
    name: 'read',
    label: 'Read',
    description: 'Read a file.',
    parameters: Type.Object({ path: Type.String() }),
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }], details: {} }),
  };
  const bundle = await openCapabilityBundle({ catalog, definitionVersion: 'worker@1' });
  const operation = await bundle.openOperation({
    workspace,
    scratchDir: join(root, 'scratch'),
    gate,
    action: 'work',
    disabledTools: ['read', 'extension_probe'],
    hostTools: () => [hostTool],
  });
  try {
    expect(operation.tools).toEqual([]);
    expect(operation.piExtensionTools).toEqual([]);
    expect(operation.allowedToolNames).toEqual([]);
    expect(operation.report.find(item => item.id === 'pi-probe')?.tools).toEqual([]);
  } finally {
    await operation.close();
  }
});

test('bundle identity changes with injected content but not with operation grants or read-only overlay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-identity-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const skill = join(capabilityRoot, 'skill');
  await capability(capabilityRoot, 'skill', { id: 'skill', kind: 'skill', version: '1.0.0', name: 'Skill' }, { 'SKILL.md': '# Skill\n\nVersion one.\n' });
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('worker', { recommendedGrade: 'medium', capabilities: [{ id: 'skill', version: '1.0.0' }] });

  const first = await openCapabilityBundle({ catalog, definitionVersion: 'worker@1' });
  await writeFile(join(skill, 'SKILL.md'), '# Skill\n\nVersion two.\n');
  await catalog.refresh();
  const second = await openCapabilityBundle({ catalog, definitionVersion: 'worker@1' });
  expect(second.digest).not.toBe(first.digest);
});

test('bundle identity is based on content rather than the capability root path', async () => {
  const roots = await Promise.all([
    mkdtemp(join(tmpdir(), 'graph-capability-root-a-')),
    mkdtemp(join(tmpdir(), 'graph-capability-root-b-')),
  ]);
  cleanup.push(() => Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))).then(() => undefined));
  const bundles = [];
  for (const root of roots) {
    const capabilityRoot = join(root, 'capabilities');
    await capability(capabilityRoot, 'skill', { id: 'skill', kind: 'skill', version: '1.0.0', name: 'Skill' }, { 'SKILL.md': '# Same content\n' });
    const store = new TaskStore(join(root, 'tasks.sqlite'));
    cleanup.push(() => store.close());
    const catalog = new Catalog(store, { capabilityRoot });
    await catalog.refresh();
    catalog.publishDefinition('worker', { recommendedGrade: 'medium', capabilities: [{ id: 'skill', version: '1.0.0' }] });
    bundles.push(await openCapabilityBundle({ catalog, definitionVersion: 'worker@1' }));
  }
  expect(bundles[1]!.digest).toBe(bundles[0]!.digest);
});

test('editable prompt overrides do not rotate the pinned capability identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-capability-prompts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot: join(root, 'capabilities') });
  await catalog.refresh();
  const first = await openCapabilityBundle({ catalog, bootstrap: { agent: 'Prompt version one' } });
  const second = await openCapabilityBundle({ catalog, bootstrap: { agent: 'Prompt version two' } });
  expect(second.digest).toBe(first.digest);
});
