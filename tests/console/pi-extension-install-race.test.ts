import { mkdtemp, mkdir, rm, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { DefaultPackageManager } from '@earendil-works/pi-coding-agent';
import { recordInstallSnapshot, resolvePiExtensionSource } from '../../src/runtime/pi-extension-source.ts';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-extension-race-')); roots.push(root);
  const pkg = join(root, 'install', 'node_modules', 'probe');
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: 'probe', version: '1.0.0', pi: { extensions: ['./index.js'] } }));
  await writeFile(join(pkg, 'index.js'), 'export default function () {}');
  return { root, pkg, input: { source: pkg, cwd: root, agentDir: join(root, 'agent') } };
}

test('a changed shared install never deletes other extensions during source resolution', async () => {
  const { root, pkg, input } = await fixture();
  const sibling = join(root, 'install', 'node_modules', 'other');
  await mkdir(sibling);
  await writeFile(join(sibling, 'package.json'), '{"name":"other","version":"1.0.0"}');
  await writeFile(join(sibling, 'old.js'), 'old');
  await recordInstallSnapshot(join(root, 'install'));
  await rm(join(sibling, 'old.js'));
  await expect(resolvePiExtensionSource(input)).resolves.toMatchObject({ entries: [join(pkg, 'index.js')] });
  await expect(access(join(sibling, 'package.json'))).resolves.toBeUndefined();
});

test('different sources sharing an agent directory cannot install concurrently', async () => {
  const { input } = await fixture();
  const original = DefaultPackageManager.prototype.resolveExtensionSources;
  let active = 0;
  let peak = 0;
  vi.spyOn(DefaultPackageManager.prototype, 'resolveExtensionSources').mockImplementation(async function (this: DefaultPackageManager, ...args) {
    active++; peak = Math.max(peak, active);
    try { await new Promise(resolve => setTimeout(resolve, 20)); return await original.apply(this, args); }
    finally { active--; }
  });
  await Promise.all([resolvePiExtensionSource(input), resolvePiExtensionSource({ ...input, source: join(input.source, 'index.js') })]);
  expect(peak).toBe(1);
});

test('a failed installation releases the queue for the next source', async () => {
  const { input } = await fixture();
  vi.spyOn(DefaultPackageManager.prototype, 'resolveExtensionSources').mockRejectedValueOnce(new Error('npm failed'));
  const results = await Promise.allSettled([resolvePiExtensionSource(input), resolvePiExtensionSource(input)]);
  expect(results[0]).toMatchObject({ status: 'rejected', reason: { message: 'npm failed' } });
  expect(results[1]).toMatchObject({ status: 'fulfilled', value: { version: '1.0.0' } });
});
