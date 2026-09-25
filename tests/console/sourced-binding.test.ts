import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { Catalog } from '../../src/catalog/catalog.ts';
import { TaskStore, canonicalJson } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

test('a sourced capability still resolves for a binding that names an older version', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-sourced-binding-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'capabilities');
  const sourced = join(capabilityRoot, 'pi-sourced');
  const pinned = join(capabilityRoot, 'pi-pinned');
  await Promise.all([sourced, pinned].map(path => mkdir(path, { recursive: true })));
  await writeFile(join(sourced, 'capability.json'), canonicalJson({
    id: 'pi-sourced', kind: 'pi-extension', version: '1.2.3', name: 'Sourced', source: 'npm:some-package@^1.0.0',
  }));
  await writeFile(join(pinned, 'capability.json'), canonicalJson({
    id: 'pi-pinned', kind: 'pi-extension', version: '1.2.3', name: 'Pinned', entry: './index.mjs',
  }));
  await writeFile(join(pinned, 'index.mjs'), 'export default function () {}\n');
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  const catalog = new Catalog(store, { capabilityRoot });
  await catalog.refresh();

  // The source decides its own version, so a binding that names an older one still resolves.
  expect(catalog.capability('pi-sourced', '1.0.0')?.id).toBe('pi-sourced');
  expect(catalog.capability('pi-sourced', '1.2.3')?.version).toBe('1.2.3');
  // A vendored capability keeps version pins strict: an unknown version stays unknown.
  expect(catalog.capability('pi-pinned', '1.0.0')).toBeUndefined();
});
