import { execFileSync } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

async function isolatedSource() {
  // Keep the copied executable under the checkout so Node resolves installed
  // packages normally from its parent. No dependency symlink or install is needed.
  const tooling = join(process.cwd(), '.tooling');
  await mkdir(tooling, { recursive: true });
  const parent = await realpath(await mkdtemp(join(tooling, 'source-identity-e2e-')));
  cleanup.push(() => rm(parent, { recursive: true, force: true }));
  const source = join(parent, 'app');
  const root = join(parent, 'data');
  await mkdir(source);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div id="root">Source identity fixture</div>');
  for (const directory of ['src', 'presets', 'docs']) await cp(join(process.cwd(), directory), join(source, directory), { recursive: true });
  await copyFile(join(process.cwd(), 'package.json'), join(source, 'package.json'));
  async function launch() {
    const daemon = await launchCli(root, { sourceRoot: source, env: {
      GRAPH_RSI_ROOT: source,
      // A packaged tree must not accidentally discover the development checkout
      // above this fixture. Nested fixture repositories remain discoverable.
      GIT_CEILING_DIRECTORIES: parent,
    } });
    cleanup.push(() => daemon.close());
    return { daemon, async identity() {
      const response = await daemon.request('/api/startup');
      expect(response.status).toBe(200);
      return (await response.json() as { source: { root: string; commit: string | null; branch: string | null; dirty: boolean | null } }).source;
    } };
  }
  return { source, launch };
}

test('the real CLI reports its startup commit and keeps that identity until the next process starts', async () => {
  const fixture = await isolatedSource();
  git(fixture.source, ['init', '-q', '-b', 'main']);
  git(fixture.source, ['add', '.']);
  git(fixture.source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'source']);
  const sha = git(fixture.source, ['rev-parse', 'HEAD']);
  const running = await fixture.launch();
  const clean = { root: fixture.source, commit: sha, branch: 'main', dirty: false };
  expect(await running.identity()).toEqual(clean);
  await writeFile(join(fixture.source, 'uncommitted.ts'), 'export const changed = true;\n');
  expect(await running.identity()).toEqual(clean);
  await running.daemon.close();
  const changed = await fixture.launch();
  expect(await changed.identity()).toEqual({ ...clean, dirty: true });
  await changed.daemon.close();
  await rm(join(fixture.source, 'uncommitted.ts'));
  git(fixture.source, ['checkout', '-q', '--detach', 'HEAD']);
  const detached = await fixture.launch();
  expect(await detached.identity()).toEqual({ ...clean, branch: null });
}, 60000);

test('a packaged source tree and a directory without package metadata report unknown Git identity', async () => {
  const fixture = await isolatedSource();
  const unknown = { root: fixture.source, commit: null, branch: null, dirty: null };
  const packaged = await fixture.launch();
  expect(await packaged.identity()).toEqual(unknown);
  await packaged.daemon.close();
  await rm(join(fixture.source, 'package.json'));
  const plain = await fixture.launch();
  expect(await plain.identity()).toEqual(unknown);
}, 60000);
