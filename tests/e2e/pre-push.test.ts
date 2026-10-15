import { execFile } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, test } from 'vitest';

const run = promisify(execFile);

test('a real local Git push executes the shipped gate, preserves failed evidence and permits the corrected push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-push-e2e-'));
  const repo = join(root, 'repo');
  const remote = join(root, 'remote.git');
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: root, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const git = (...args: string[]) => run('git', args, { cwd: repo, env });
  try {
    await mkdir(repo);
    await run('git', ['init', '--bare', remote], { env });
    await git('init', '-b', 'main');
    await git('config', 'user.name', 'E2E fixture');
    await git('config', 'user.email', 'fixture@example.invalid');
    await mkdir(join(repo, '.githooks'));
    await copyFile(join(process.cwd(), '.githooks/pre-push'), join(repo, '.githooks/pre-push'));
    await chmod(join(repo, '.githooks/pre-push'), 0o755);
    await git('config', 'core.hooksPath', '.githooks');
    await git('remote', 'add', 'origin', remote);
    // This is a real project gate. A nested Git operation additionally proves
    // that the shipped hook clears repository variables inherited from Git.
    await writeFile(join(repo, 'package.json'), JSON.stringify({ scripts: { check: 'node check.mjs' } }));
    await writeFile(join(repo, 'check.mjs'), `import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const foreignRoot = execFileSync('git', ['-C', process.env.GRAPH_PUSH_FOREIGN_ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
if (foreignRoot !== process.env.GRAPH_PUSH_FOREIGN_ROOT) throw new Error('Git repository variables leaked into project gate');
if (readFileSync('gate-state', 'utf8') === 'fail') {
  console.error('FAIL project gate > intentional external project failure');
  process.exit(1);
}
console.log('project gate passed');
`);
    const foreign = join(root, 'foreign');
    await mkdir(foreign);
    await run('git', ['init', foreign], { env });
    env.GRAPH_PUSH_FOREIGN_ROOT = foreign;
    await writeFile(join(repo, 'gate-state'), 'pass');
    await git('add', '.'); await git('commit', '-m', 'Initial project');
    const passed = await git('push', '-u', 'origin', 'main');
    expect(passed.stdout.trim().split('\n').filter(line => line.startsWith('pre-push gate'))).toHaveLength(1);
    expect(passed.stdout).not.toContain('project gate passed');
    expect(passed.stdout).toContain('pre-push gate passed');
    const first = (await git('rev-parse', 'HEAD')).stdout.trim();
    await writeFile(join(repo, 'gate-state'), 'fail');
    await git('add', 'gate-state'); await git('commit', '-m', 'Failing project gate');
    let rejected = '';
    try { await git('push'); throw new Error('Failing gate permitted push'); }
    catch (error) {
      const failure = error as { code?: number; stderr?: string };
      expect(failure.code).toBe(1);
      rejected = failure.stderr ?? '';
    }
    expect(rejected).toContain('FAIL project gate > intentional external project failure');
    expect((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { env })).stdout.trim()).toBe(first);
    const kept = rejected.match(/this failure kept at: (.+\.log)/)?.[1];
    expect(kept).toBeTruthy();
    const evidence = await readFile(kept!, 'utf8');
    expect(evidence).toContain('FAIL project gate > intentional external project failure');
    await writeFile(join(repo, 'gate-state'), 'pass');
    await git('add', 'gate-state'); await git('commit', '-m', 'Corrected project gate');
    expect((await git('push')).stdout).toContain('pre-push gate passed');
    expect((await run('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/main'], { env })).stdout.trim()).toBe((await git('rev-parse', 'HEAD')).stdout.trim());
    expect(await readFile(kept!, 'utf8')).toBe(evidence);
    expect((await readdir(root)).filter(name => name.includes('failed-'))).toHaveLength(1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
