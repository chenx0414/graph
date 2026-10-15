import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const commit = (cwd: string) => {
  git(cwd, ['add', '-A']);
  git(cwd, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'fixture']);
};

async function workspace() {
  const parent = await mkdtemp(join(tmpdir(), 'graph-drift-e2e-'));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  await mkdir(join(parent, 'data/web'), { recursive: true });
  await writeFile(join(parent, 'data/web/index.html'), '<!doctype html><div id="root">Drift fixture</div>');
  async function checkout(name: string, origin = 'https://example.invalid/graph.git') {
    const root = join(parent, name);
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"graph","type":"module"}');
    await writeFile(join(root, 'src/keep.ts'), 'export const value = 1;\n');
    git(root, ['init', '-q', '-b', 'main']);
    commit(root);
    git(root, ['remote', 'add', 'origin', origin]);
    return root;
  }
  async function start(deployed: string, configured?: string) {
    const daemon = await launchCli(join(parent, 'data'), { env: {
      GRAPH_RSI_ROOT: deployed, GRAPH_DEVELOPMENT_ROOT: configured ?? '',
    } });
    cleanup.push(() => daemon.close());
    const token = (await readFile(join(parent, 'data/state/app-token'), 'utf8')).trim();
    return async (compare = true) => {
      const response = await daemon.request(`/api/app/rsi/status${compare ? '?compare=1' : ''}`, { headers: { 'x-graph-app-token': token } });
      expect(response.status).toBe(200);
      return await response.json() as { available: boolean; sync: { deploy?: { root: string; files: string[]; missing: string[]; extra: string[]; runtimeFiles: string[]; note: string } } };
    };
  }
  return { parent, checkout, start };
}

test('desktop status compares matching repositories without changing either Git index', async () => {
  const fixture = await workspace();
  const deployed = await fixture.checkout('deployed');
  const development = await fixture.checkout('development');
  const unrelated = await fixture.checkout('unrelated', 'https://example.invalid/other.git');
  await writeFile(join(unrelated, 'src/keep.ts'), 'export const value = 999;\n');
  commit(unrelated);
  const status = await fixture.start(deployed);
  expect(await status(false)).toMatchObject({ available: true, sync: {} });
  expect((await status(false)).sync).not.toHaveProperty('deploy');
  expect((await status()).sync.deploy).toMatchObject({ root: development, files: [], missing: [], extra: [], runtimeFiles: [], note: expect.stringContaining('一致') });
  await writeFile(join(development, 'src/keep.ts'), 'export const value = 2;\n');
  await writeFile(join(development, 'tests-added.ts'), '// development only\n');
  commit(development);
  await writeFile(join(deployed, 'src/deployed-only.ts'), 'export const local = true;\n');
  commit(deployed);
  const indexes = [deployed, development].map(root => join(root, '.git/index'));
  const before = await Promise.all(indexes.map(path => readFile(path)));
  const drift = (await status()).sync.deploy;
  expect(drift).toMatchObject({ root: development, files: ['src/keep.ts'], missing: ['tests-added.ts'], extra: ['src/deployed-only.ts'], runtimeFiles: ['src/deployed-only.ts', 'src/keep.ts'] });
  expect(drift!.note).toContain('development');
  expect(drift!.note).toContain('src/keep.ts');
  expect(await Promise.all(indexes.map(path => readFile(path)))).toEqual(before);
}, 60000);

test('desktop status resolves a deployed worktree through its common repository origin', async () => {
  const fixture = await workspace();
  const main = await fixture.checkout('development');
  const deployed = join(fixture.parent, 'deployed');
  git(main, ['worktree', 'add', '-q', '-b', 'deployed', deployed]);
  await writeFile(join(main, 'src/keep.ts'), 'export const value = 2;\n');
  commit(main);
  const status = await fixture.start(deployed);
  expect((await status()).sync.deploy).toMatchObject({ root: main, files: ['src/keep.ts'], missing: [], extra: [] });
}, 60000);

test('an explicitly configured development checkout wins over automatic sibling discovery', async () => {
  const fixture = await workspace();
  const deployed = await fixture.checkout('deployed');
  await fixture.checkout('sibling');
  const configured = await fixture.checkout('configured', 'https://example.invalid/other.git');
  await writeFile(join(configured, 'src/keep.ts'), 'export const value = 3;\n');
  commit(configured);
  const status = await fixture.start(deployed, configured);
  expect((await status()).sync.deploy).toMatchObject({ root: configured, files: ['src/keep.ts'] });
}, 60000);
