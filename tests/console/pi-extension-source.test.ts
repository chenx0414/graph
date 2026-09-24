import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { openCapabilityBundle } from '../../src/runtime/capability-bundle.ts';
import { npmSourceName, piExtensionSourceStatus } from '../../src/runtime/pi-extension-source.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('a Pi extension capability may declare a package source instead of a vendored entry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-extension-source-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const capabilityRoot = join(root, 'capabilities');
  const capabilityDir = join(capabilityRoot, 'pi-sourced');
  const packageDir = join(root, 'packages', 'pi-probe-package');
  await Promise.all([workspace, capabilityDir, join(packageDir, 'dist', 'ext')].map(path => mkdir(path, { recursive: true })));
  // A published Pi package declares its own extension entries; Graph must not need `entry`.
  await writeFile(join(packageDir, 'package.json'), canonicalJson({ name: 'pi-probe-package', version: '1.2.3', pi: { extensions: ['./dist/ext/index.mjs'] } }));
  await writeFile(join(packageDir, 'dist', 'ext', 'index.mjs'), 'export default function () {}\n');
  await writeFile(join(capabilityDir, 'capability.json'), canonicalJson({
    id: 'pi-sourced',
    kind: 'pi-extension',
    version: '1.2.3',
    name: 'Sourced extension',
    source: packageDir,
    tools: [{ name: 'sourced_probe', description: 'Probe the sourced extension.' }],
  }));

  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();
  catalog.publishDefinition('sourced-agent', {
    recommendedGrade: 'medium',
    capabilities: [{ id: 'pi-sourced', version: '1.2.3' }],
  });
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'sourced-agent');
  cleanup.push(() => gate.close());
  const bundle = await openCapabilityBundle({ catalog, definitionVersion: 'sourced-agent@1' });
  const operation = await bundle.openOperation({
    workspace,
    scratchDir: join(root, 'scratch'),
    gate,
    action: 'work',
    hostTools: () => [],
  });
  try {
    expect(operation.piExtensionPaths).toHaveLength(1);
    expect(await realpath(operation.piExtensionPaths[0]!)).toBe(join(await realpath(packageDir), 'dist', 'ext', 'index.mjs'));
    expect(operation.piExtensionTools).toEqual(['sourced_probe']);
    expect(operation.report).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'pi-sourced', kind: 'pi-extension', loaded: true, source: packageDir }),
    ]));
    // Nothing is vendored: the loaded entry lives outside the capability snapshot.
    expect(operation.piExtensionPaths[0]!.startsWith(capabilityDir)).toBe(false);
  } finally {
    await operation.close();
  }
});

test('a source reports the installed version, and only npm sources are checked for updates', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-extension-status-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const packageDir = join(root, 'packages', 'pi-probe-package');
  await mkdir(join(packageDir, 'dist', 'ext'), { recursive: true });
  await writeFile(join(packageDir, 'package.json'), canonicalJson({ name: 'pi-probe-package', version: '1.2.3', pi: { extensions: ['./dist/ext/index.mjs'] } }));
  await writeFile(join(packageDir, 'dist', 'ext', 'index.mjs'), 'export default function () {}\n');

  // A local source has no registry to ask, so it reports what is on disk and no update.
  expect(await piExtensionSourceStatus({ source: packageDir, cwd: root, agentDir: join(root, 'state') }))
    .toEqual({ installed: '1.2.3', latest: null, available: false });
  expect(npmSourceName(packageDir)).toBeNull();
  expect(npmSourceName('npm:pi-agent-browser-native')).toBe('pi-agent-browser-native');
  expect(npmSourceName('npm:@ff-labs/pi-fff@^0.10.0')).toBe('@ff-labs/pi-fff');
});
