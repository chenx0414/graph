import { describe, expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertMainBuildSource } from '../../scripts/app-build-source.mjs';

function git(root: string, args: string[]) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

async function repository() {
  const root = await mkdtemp(join(tmpdir(), 'graph-app-source-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 'graph@example.com']);
  git(root, ['config', 'user.name', 'Graph']);
  await writeFile(join(root, 'README.md'), '# graph\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-q', '-m', 'init']);
  return root;
}

describe('the app build source', () => {
  test('a main checkout is the only thing the app is packaged from', async () => {
    const root = await repository();
    try {
      expect(assertMainBuildSource(root)).toBe('main');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a side branch is refused, so a package can never come from one', async () => {
    const root = await repository();
    try {
      git(root, ['switch', '-q', '-c', 'rsi/side']);
      expect(() => assertMainBuildSource(root)).toThrow(/main/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a detached checkout of a commit main contains is allowed', async () => {
    const root = await repository();
    try {
      git(root, ['switch', '-q', '--detach', 'main']);
      expect(assertMainBuildSource(root)).toBe('main');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a detached checkout of a commit main does not contain is refused', async () => {
    const root = await repository();
    try {
      git(root, ['switch', '-q', '-c', 'stray']);
      await writeFile(join(root, 'stray.txt'), 'stray\n');
      git(root, ['add', '-A']);
      git(root, ['commit', '-q', '-m', 'stray']);
      git(root, ['switch', '-q', '--detach', 'HEAD']);
      git(root, ['branch', '-q', '-D', 'stray']);
      expect(() => assertMainBuildSource(root)).toThrow(/main/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
