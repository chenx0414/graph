import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { openCapabilityBundle } from '../../src/runtime/capability-bundle.ts';
import { npmSourceName, piExtensionSourceStatus, resolvePiExtensionSource } from '../../src/runtime/pi-extension-source.ts';
import { parseGraphConfig } from '../../src/server/config.ts';

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

test('a source reports the declared entries its install root does not ship, as a diagnostic', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pi-source-gaps-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const install = join(root, 'install');
  const pkg = join(install, 'node_modules', 'pi-probe-gaps');
  const healthy = join(install, 'node_modules', 'healthy-dep');
  const quirky = join(install, 'node_modules', 'quirky-dep');
  await Promise.all([pkg, healthy, quirky].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(pkg, 'index.mjs'), 'export default function () {}\n');
  await writeFile(join(pkg, 'package.json'), canonicalJson({ name: 'pi-probe-gaps', version: '1.0.0', pi: { extensions: ['./index.mjs'] } }));
  // `healthy-dep` ships everything it declares; `quirky-dep` declares a root entry and ships no
  // such file — exactly the upstream quirk (`@modelcontextprotocol/sdk@1.30.1`) that used to be
  // mistaken for a damaged install.
  await writeFile(join(healthy, 'index.js'), 'export const value = 1;\n');
  await writeFile(join(healthy, 'package.json'), canonicalJson({ name: 'healthy-dep', version: '1.0.0', main: './index.js' }));
  await writeFile(join(quirky, 'package.json'), canonicalJson({ name: 'quirky-dep', version: '1.0.0', exports: { '.': { import: './dist/index.js' } } }));

  const status = await piExtensionSourceStatus({ source: pkg, cwd: root, agentDir: join(root, 'agent') });
  expect(status.installGaps.join('\n')).toContain('quirky-dep');
  expect(status.installGaps.join('\n')).not.toContain('healthy-dep');
  // Reporting is all it does: the diagnostic must not change what the source resolves to.
  expect(status.installed).toBe('1.0.0');
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
    .toEqual({ installed: '1.2.3', latest: null, available: false, installGaps: [] });
  // The same resolve also reports the version the source provides, so the manifest can follow it.
  const resolved = await resolvePiExtensionSource({ source: packageDir, cwd: root, agentDir: join(root, 'state') });
  expect(resolved.version).toBe('1.2.3');
  expect(npmSourceName(packageDir)).toBeNull();
  expect(npmSourceName('npm:pi-agent-browser-native')).toBe('pi-agent-browser-native');
  expect(npmSourceName('npm:@ff-labs/pi-fff@^0.10.0')).toBe('@ff-labs/pi-fff');
});

test('the Pi extension auto-update setting survives a config round trip', () => {
  const base = {
    version: 1,
    projects: [],
    credentials: {},
    limits: { credentials: {}, sharedGroups: {}, defaultBudgetTokens: null },
    access: {},
  };
  // The switch defaults to on, and an explicit value always wins.
  expect(parseGraphConfig(base, '/tmp/graph.config.json').piExtensionAutoUpdate).toBe(true);
  expect(parseGraphConfig({ ...base, piExtensionAutoUpdate: false }, '/tmp/graph.config.json').piExtensionAutoUpdate).toBe(false);
  expect(parseGraphConfig({ ...base, piExtensionAutoUpdate: true }, '/tmp/graph.config.json').piExtensionAutoUpdate).toBe(true);
});
