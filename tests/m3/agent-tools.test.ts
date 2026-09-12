import { link, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentTools } from '../../src/runtime/agent-tools.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), 'graph-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const scope = join(root, 'workspace');
  const outside = join(root, 'outside');
  await mkdir(scope); await mkdir(outside);
  const tools = agentTools({ workspace: scope });
  const call = (name: string, params: Record<string, unknown>) =>
    (tools.find(item => item.name === name)!.execute as unknown as (id: string, params: unknown) => Promise<{ content: { type: string; text?: string }[] }>)('probe', params);
  return { root, scope, outside, call };
}

test('a workspace tool cannot write through a symlinked directory', async () => {
  const { scope, outside, call } = await workspace();
  await writeFile(join(outside, 'evidence.txt'), 'outside');
  await symlink(outside, join(scope, 'linked'));
  await expect(call('write_file', { path: 'linked/evidence.txt', content: 'changed' }))
    .rejects.toThrow('symbolic link');
  expect(await readFile(join(outside, 'evidence.txt'), 'utf8')).toBe('outside');
});

test('a workspace tool cannot write to or read through a symlinked file', async () => {
  const { scope, outside, call } = await workspace();
  await writeFile(join(outside, 'secret.txt'), 'secret');
  await symlink(join(outside, 'secret.txt'), join(scope, 'alias.txt'));
  await expect(call('read', { path: 'alias.txt' })).rejects.toThrow('symbolic link');
  await expect(call('write_file', { path: 'alias.txt', content: 'changed' }))
    .rejects.toThrow('symbolic link');
  expect(await readFile(join(outside, 'secret.txt'), 'utf8')).toBe('secret');
});

test('a workspace tool refuses a hard link onto a file outside the work copy', async () => {
  const { scope, outside, call } = await workspace();
  await writeFile(join(outside, 'formal.txt'), 'formal');
  await link(join(outside, 'formal.txt'), join(scope, 'hard.txt'));
  await expect(call('write_file', { path: 'hard.txt', content: 'changed' }))
    .rejects.toThrow('multiply-linked');
  expect(await readFile(join(outside, 'formal.txt'), 'utf8')).toBe('formal');
});

test('a workspace tool refuses Git metadata and escaping paths', async () => {
  const { scope, call } = await workspace();
  await mkdir(join(scope, '.git'));
  await writeFile(join(scope, '.git', 'config'), 'safe');
  await expect(call('write_file', { path: '.git/config', content: 'bad' })).rejects.toThrow('Git metadata');
  await expect(call('read', { path: '.git/config' })).rejects.toThrow('Git metadata');
  await expect(call('write_file', { path: '../outside.txt', content: 'bad' })).rejects.toThrow('outside the workspace');
  await expect(call('read', { path: '/etc/hosts' })).rejects.toThrow('outside the workspace');
  expect(await readFile(join(scope, '.git', 'config'), 'utf8')).toBe('safe');
});

test('a workspace tool still creates nested files and lists directories inside the work copy', async () => {
  const { scope, call } = await workspace();
  await writeFile(join(scope, 'README.md'), 'project\n');
  await expect(call('write_file', { path: 'src/web/index.html', content: '<html>ok</html>' }))
    .resolves.toMatchObject({ details: {} });
  expect(await readFile(join(scope, 'src/web/index.html'), 'utf8')).toBe('<html>ok</html>');
  expect(await call('list_dir', { path: '.' })).toMatchObject({
    content: [{ type: 'text', text: expect.stringContaining('src') }],
  });
  expect((await call('read', { path: 'src/web/index.html' })).content[0]).toMatchObject({ text: '<html>ok</html>' });
  expect((await call('read', { path: join(await realpath(scope), 'src/web/index.html') })).content[0]).toMatchObject({ text: '<html>ok</html>' });
});
