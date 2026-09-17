import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { loadCapabilities } from '../../src/runtime/capabilities.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

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
  const loaded = await loadCapabilities({
    catalog,
    definitionVersion: 'bundle-agent@1',
    workspace,
    scratchDir: join(root, 'scratch'),
    gate,
  });
  try {
    expect(loaded.skillPaths).toEqual([await realpath(skill)]);
    expect(loaded.piExtensionPaths).toEqual([join(await realpath(extension), 'index.ts')]);
    expect(loaded.piExtensionTools).toEqual(['extension_probe']);
    expect(loaded.prompts).toEqual({
      agent: 'You are the bundle test Agent.',
      tool: 'Use only the declared capability bundle.',
    });
    expect(loaded.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'skill-read', kind: 'skill', loaded: true }),
      expect.objectContaining({ id: 'pi-probe', kind: 'pi-extension', loaded: true, tools: ['extension_probe'] }),
      expect.objectContaining({ id: 'prompt-identity', kind: 'prompt', loaded: true }),
      expect.objectContaining({ id: 'prompt-awareness', kind: 'prompt', loaded: true }),
    ]));
    expect(loaded.digest).toMatch(/^[a-f0-9]{64}$/);
  } finally {
    await loaded.close();
  }
});
