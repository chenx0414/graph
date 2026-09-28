import { mkdtempSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { git as runGit } from '../../src/git/git.ts';
import { graphApplicationRoot } from '../../src/runtime/graph-root.ts';
import { RsiService, resolveRsiRoot, type RsiValidationResult } from '../../src/runtime/rsi.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

function shell(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-rsi-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  shell(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'graph', scripts: { check: 'true' } }, null, 2));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'keep.ts'), 'export const value = 1;\n');
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'init']);
  return root;
}

/** A real ledger with one project, conversation and anchor task. */
function ledger() {
  const dir = mkdtempSync(join(tmpdir(), 'graph-rsi-state-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(join(dir, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  const taskId = 'task-rsi';
  const conversationId = 'conversation-rsi';
  const now = Date.now();
  store.db.prepare('INSERT INTO projects VALUES(?,?,?)').run('p', '/tmp/p', '[]');
  store.db.prepare('INSERT INTO tasks(id,project_id,request,created_seq,conversation_id) VALUES(?,?,?,?,?)')
    .run(taskId, 'p', 'improve graph', 1, conversationId);
  store.db.prepare(`INSERT INTO conversations(id,project_id,workspace_project_id,anchor_task_id,title,created_seq,created_at,binding_since_seq)
    VALUES(?,?,?,?,?,?,?,?)`).run(conversationId, 'p', 'p', taskId, 'rsi', 1, now, 1);
  return { store, taskId, conversationId, dir };
}

const passing = async (): Promise<RsiValidationResult[]> => [{ command: 'mock check', status: 'passed', output: '' }];

function service(root: string, stateDir: string, validate = passing) {
  return new RsiService({ root, stateDir, validate });
}

test('a passed check keeps only its verdict and the full log moves to a report file', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const noisy = async (): Promise<RsiValidationResult[]> => [
    { command: 'node --run check', status: 'passed', output: 'x'.repeat(20_000) },
  ];
  const receipt = await service(root, dir, noisy).apply({
    title: 'Quiet receipt',
    activate: false,
    problem: 'Keep the conversation receipt small.',
    changes: [],
    checks: [{ command: 'node', args: ['--run', 'check'] }],
  }, { store, taskId, conversationId });
  expect(receipt.validation).toEqual([{ command: 'node --run check', status: 'passed', output: '' }]);
  expect(receipt.outputPath).toBeTruthy();
  expect((await readFile(receipt.outputPath!, 'utf8')).length).toBeGreaterThan(20_000);
  expect(receipt.report).toContain('完整日志');
});

test('a runtime-only change skips app:build while a web change still builds', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const seen: (boolean | undefined)[] = [];
  const spy = async (input: { root: string; checks: { command: string; args: string[] }[]; activate: boolean; needsBuild?: boolean }): Promise<RsiValidationResult[]> => {
    seen.push(input.needsBuild);
    return [{ command: 'mock check', status: 'passed', output: '' }];
  };
  const rsi = service(root, dir, spy as never);
  await rsi.apply({
    title: 'Runtime only', activate: false, problem: 'No bundle change.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 2;\n' }],
  }, { store, taskId, conversationId });
  expect(seen[0]).toBe(false);
  await rsi.apply({
    title: 'Web change', activate: false, problem: 'The bundle changes.',
    changes: [{ path: 'src/web/panel.tsx', action: 'write', content: 'export const Panel = 1;\n' }],
  }, { store, taskId, conversationId });
  expect(seen[1]).toBe(true);
});

/**
 * A checkout whose `app:build` fails the way a download abort does, once, then succeeds.
 *
 * The scripts are real files run by the real `defaultValidate`, so this exercises the retry path
 * end to end instead of a stubbed runner.
 */
async function buildRepo(flaky: boolean) {
  const root = await mkdtemp(join(tmpdir(), 'graph-rsi-build-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  shell(root, ['init', '-b', 'main']);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'build.mjs'), flaky
    // Fails with electron-builder's abort wording until it has left a marker, then succeeds.
    ? [
      "import { existsSync, writeFileSync } from 'node:fs';",
      "import { tmpdir } from 'node:os';",
      "import { basename, join } from 'node:path';",
      // The marker lives outside the checkout: a build that dirtied the repo would be refused by
      // the RSI dirty guard for a reason that has nothing to do with what is being tested.
      "const marker = join(tmpdir(), `graph-rsi-built-${basename(process.cwd())}`);",
      "if (!existsSync(marker)) { writeFileSync(marker, '1'); console.error('The server aborted pending request'); process.exit(1); }",
      '',
    ].join('\n')
    : ["console.error('src/web/panel.tsx(1,1): error TS1005: a real compile error');", 'process.exit(1);', ''].join('\n'));
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'graph', scripts: { check: 'true', 'app:build': 'node scripts/build.mjs' },
  }, null, 2));
  await mkdir(join(root, 'src', 'web'), { recursive: true });
  await writeFile(join(root, 'src', 'web', 'panel.tsx'), 'export const Panel = 1;\n');
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'init']);
  return root;
}

test('a build interrupted by a download is retried once and does not fail the activation', async () => {
  const root = await buildRepo(true);
  const { store, taskId, conversationId, dir } = ledger();
  // No injected validate: this runs the real `defaultValidate` and the real build script.
  const receipt = await new RsiService({ root, stateDir: dir }).apply({
    title: 'Web change with a flaky download', activate: true, problem: 'A download aborted mid-build.',
    changes: [{ path: 'src/web/panel.tsx', action: 'write', content: 'export const Panel = 2;\n' }],
  }, { store, taskId, conversationId });
  const build = receipt.validation.find(result => result.command.includes('app:build'));
  expect(build?.status).toBe('passed');
  expect(receipt.status).not.toBe('checks_failed');
  // The retry is reported, so a slow activation is explained instead of looking like a clean build.
  expect(await readFile(receipt.outputPath!, 'utf8')).toContain('已自动重跑一次并成功');
});

test('a genuine build failure still blocks, and is not dressed up as a network flake', async () => {
  const root = await buildRepo(false);
  const { store, taskId, conversationId, dir } = ledger();
  const receipt = await new RsiService({ root, stateDir: dir }).apply({
    title: 'Web change that breaks the build', activate: true, problem: 'A real compile error.',
    changes: [{ path: 'src/web/panel.tsx', action: 'write', content: 'export const Panel = 3;\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('checks_failed');
  expect(receipt.validation.find(result => result.command.includes('app:build'))?.status).toBe('failed');
});

// A batch written with `file` instead of `path` once cost a whole round trip: the key has exactly
// one meaning, so the alias is accepted rather than handed back to be corrected by hand.
test('accepts a change that names its file as `file`', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  await service(root, dir).apply({
    title: 'Alias', activate: false, problem: 'A batch written with the wrong key.',
    changes: [{ file: 'src/keep.ts', action: 'write', content: 'export const value = 9;\n' }] as never,
  }, { store, taskId, conversationId });
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 9');
});

// The refusal has to name the shape: the batch was resent whole while the error only said which key
// was missing.
test('refuses a change with no file key and names the shape', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  let error: Error | undefined;
  try {
    await service(root, dir).apply({
      title: 'Missing path', activate: false, problem: 'No file key at all.',
      changes: [{ action: 'write', content: 'x' }] as never,
    }, { store, taskId, conversationId });
  } catch (thrown) {
    error = thrown as Error;
  }
  expect(error?.message).toContain('changes[0].path is required');
  expect(error?.message).toContain('edits: [{oldText, newText}]');
});

test('an activation that commits nothing new does not schedule a reload', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  await service(root, dir).apply({
    title: 'Land a change', activate: false, problem: 'Commit once.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 3;\n' }],
  }, { store, taskId, conversationId });
  // A later service sees that commit as the running build, exactly like a daemon that already
  // reloaded it: nothing new is pending, so activation must not interrupt the user again.
  const receipt = await service(root, dir).apply({
    title: 'Re-run the gate', activate: true, problem: 'Choose the confirmed program checks.',
    changes: [],
    checks: [{ command: 'node', args: ['--run', 'check'] }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.restartRequired).toBe(false);
  // The behaviour under test is real and stays: a checks-only re-run must not interrupt the user
  // with a reload. What changed (HB-179) is the label: this call committed nothing, so it may not
  // claim the commit is "running" - that sentence is what once covered a checkout holding no such
  // commit at all. The state now says the honest thing.
  expect(receipt.activation).toEqual({ state: 'checked_only' });
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
  expect(receipt.report).toContain('没有产生提交');
});

test('an activation writes the turn receipt into the conversation before the reload', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const receipt = await service(root, dir).apply({
    title: 'Land a change', problem: 'The receipt has to survive the reload.',
    changes: [{ path: 'src/receipt.ts', action: 'write', content: 'export const receipt = true;\n' }],
    activate: true,
  }, { store, taskId, conversationId });
  expect(receipt.restartRequired).toBe(true);

  // The reload drains the daemon and can kill the turn before it settles, so the
  // visible receipt must already be durable when the reload is scheduled: the
  // user must never have to ask for it again.
  const reply = store.db.prepare("SELECT role,kind,text FROM messages WHERE conversation_id=? AND role='assistant' AND kind='chat'")
    .get(conversationId) as { role: string; kind: string; text: string } | undefined;
  expect(reply?.text).toContain('等待重载');
});

test('status reports an available checkout and its branch', async () => {
  const root = await repo();
  const real = await realpath(root);
  const { dir } = ledger();
  const status = await service(root, dir).status();
  expect(status.available).toBe(true);
  expect(status.root).toBe(real);
  expect(status.branch).toBe('main');
  expect(status.pendingRestart).toBeNull();
});

test('status reports unavailable when the root is not a Graph checkout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graph-rsi-empty-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const status = await new RsiService({ root: dir, stateDir: dir, validate: passing }).status();
  expect(status.available).toBe(false);
  expect(status.pendingRestart).toBeNull();
});

test('apply writes files, commits to an rsi branch and schedules a reload', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const receipt = await rsi.apply({
    title: 'Add a helper',
    problem: 'A repeated helper is missing.',
    changes: [{ path: 'src/helper.ts', action: 'write', content: 'export const helper = () => 1;\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.branch).toMatch(/^rsi\//);
  expect(receipt.commit).toMatch(/^[0-9a-f]{40}$/);
  expect(receipt.files).toEqual(['src/helper.ts']);
  expect(receipt.restartRequired).toBe(true);
  expect(await readFile(join(root, 'src', 'helper.ts'), 'utf8')).toContain('helper');
  expect(shell(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatch(/^rsi\//);
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('rsi: Add a helper');
  const restart = JSON.parse(await readFile(join(dir, 'rsi', 'restart.json'), 'utf8')) as { id: string; commit: string };
  expect(restart.id).toBe(receipt.id);
  expect(restart.commit).toBe(receipt.commit);
  // The change is reported to the user as a durable conversation message, and the
  // turn's visible receipt follows it (see the receipt test below).
  const message = store.db.prepare("SELECT role,kind,data FROM messages WHERE conversation_id=? AND kind='rsi' ORDER BY seq DESC LIMIT 1").get(conversationId) as { role: string; kind: string; data: string };
  expect(message.role).toBe('system');
  expect(message.kind).toBe('rsi');
  expect((JSON.parse(message.data) as { status: string }).status).toBe('applied');
  expect((store.db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='rsi.change'").get() as { count: number }).count).toBe(1);
});

test('apply replaces exactly once and refuses ambiguous edits', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const applied = await rsi.apply({
    title: 'Bump value',
    activate: false,
    problem: 'Value should be two.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'value = 1', newText: 'value = 2' }] }],
  }, { store, taskId, conversationId });
  expect(applied.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 2');

  const ambiguous = await rsi.apply({
    title: 'Bad edit',
    problem: 'Missing text.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'does-not-exist', newText: 'x' }] }],
  }, { store, taskId, conversationId });
  expect(ambiguous.status).toBe('rolled_back');
  expect(ambiguous.error).toContain('exactly once');
});

test('apply deletes a file and rejects path escape and .git targets', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const deleted = await rsi.apply({
    title: 'Drop keep',
    problem: 'Unused.',
    changes: [{ path: 'src/keep.ts', action: 'delete' }],
  }, { store, taskId, conversationId });
  expect(deleted.status).toBe('applied');
  expect(existsSync(join(root, 'src', 'keep.ts'))).toBe(false);

  await expect(rsi.apply({
    title: 'Escape',
    problem: 'Nope.',
    changes: [{ path: '../escape.ts', action: 'write', content: 'x' }],
  }, { store, taskId, conversationId })).rejects.toThrow(/inside the Graph source root/);

  await expect(rsi.apply({
    title: 'Git metadata',
    problem: 'Nope.',
    changes: [{ path: '.git/config', action: 'write', content: 'x' }],
  }, { store, taskId, conversationId })).rejects.toThrow(/inside the Graph source root/);
});

test('apply refuses a target file with uncommitted changes', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  await writeFile(join(root, 'src', 'keep.ts'), 'export const value = 9;\n');
  await expect(service(root, dir).apply({
    title: 'Conflict',
    problem: 'Dirty target.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 3;\n' }],
  }, { store, taskId, conversationId })).rejects.toThrow(/Uncommitted changes outside this RSI change: src\/keep\.ts/);
});

test('a failed check keeps the change so the Agent can keep fixing', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  let fails = true;
  const flaky = async (): Promise<RsiValidationResult[]> => [
    { command: 'mock check', status: fails ? 'failed' : 'passed', output: fails ? 'boom' : '' },
  ];
  const rsi = service(root, dir, flaky);
  const failed = await rsi.apply({
    title: 'Broken change',
    problem: 'Introduce a regression.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 42;\n' }],
  }, { store, taskId, conversationId });
  expect(failed.status).toBe('checks_failed');
  expect(failed.pendingFiles).toEqual(['src/keep.ts']);
  // The change survives on disk and is not committed.
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 42');
  expect(shell(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toMatch(/^rsi\//);
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('init');
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
  expect(existsSync(join(dir, 'rsi', 'working.json'))).toBe(true);

  // The same file can be edited again because the failed attempt owns it.
  fails = false;
  const fixed = await rsi.apply({
    title: 'Fix the regression',
    activate: false,
    problem: 'Correct the earlier attempt.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'value = 42', newText: 'value = 7' }] }],
  }, { store, taskId, conversationId });
  expect(fixed.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 7');
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('rsi: Fix the regression');
  expect(existsSync(join(dir, 'rsi', 'working.json'))).toBe(false);

  // A flaky failure can be retried without changing files.
  fails = true;
  const retry = await rsi.apply({
    title: 'Retry checks',
    problem: 'Check was flaky.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 8;\n' }],
  }, { store, taskId, conversationId });
  expect(retry.status).toBe('checks_failed');
  fails = false;
  const rerun = await rsi.apply({
    title: 'Retry checks',
    problem: 'Check was flaky.',
    changes: [],
  }, { store, taskId, conversationId });
  expect(rerun.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 8');
  expect(shell(root, ['log', '-1', '--format=%s'])).toBe('rsi: Retry checks');
});

test('a retry whose anchor predates the failed attempt is told which text to match', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  // Fails once, the way a flaky check does: the stale-anchor attempt is refused before checks run, and
  // the third attempt lands the change.
  let attempts = 0;
  const firstFails = async (): Promise<RsiValidationResult[]> => {
    attempts += 1;
    return [{ command: 'mock check', status: attempts === 1 ? 'failed' : 'passed', output: attempts === 1 ? 'boom' : '' }];
  };
  const rsi = service(root, dir, firstFails);
  const failed = await rsi.apply({
    title: 'Broken change',
    problem: 'Introduce a regression.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'export const value = 1;', newText: 'export const value = 2;' }] }],
  }, { store, taskId, conversationId });
  expect(failed.status).toBe('checks_failed');

  // The worktree now holds the failed attempt's text, so the anchor that was correct before it matches
  // nothing (0 occurrences). The receipt has to say which state it matched against: reaching for the
  // committed file is the trap, and "found 0" alone reads like a typo instead of a stale anchor.
  const conflicted = await rsi.apply({
    title: 'Broken change',
    problem: 'Introduce a regression.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'export const value = 1;', newText: 'export const value = 3;' }] }],
  }, { store, taskId, conversationId });
  expect(conflicted.status).toBe('rolled_back');
  expect(conflicted.error).toMatch(/found 0[\s\S]*\u4e0a\u4e00\u8f6e\u672a\u63d0\u4ea4[\s\S]*write/);

  // And what the file actually holds is what a retry matches. Nothing else about the flow changed.
  const applied = await rsi.apply({
    title: 'Finish the change',
    activate: false,
    problem: 'Correct the earlier attempt.',
    changes: [{ path: 'src/keep.ts', action: 'replace', edits: [{ oldText: 'export const value = 2;', newText: 'export const value = 4;' }] }],
  }, { store, taskId, conversationId });
  expect(applied.status).toBe('applied');
  expect(await readFile(join(root, 'src', 'keep.ts'), 'utf8')).toContain('value = 4');
});

test('activate=false commits without scheduling a reload', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const receipt = await service(root, dir).apply({
    title: 'Docs only',
    problem: 'Documentation gap.',
    activate: false,
    changes: [{ path: 'docs/note.md', action: 'write', content: '# note\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.restartRequired).toBe(false);
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
});

test('a failed check report names the failing case even when the output window lost it', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  // A real gate interleaves concurrent workers, so the failure block can sit
  // far away from the end of the captured output.
  const interleaved = [
    ' FAIL  tests/m8/app-shell-ux.test.ts > the composer suggestion and queue steering follow the three Enter states',
    'AssertionError: expected +0 to be 1 // Object.is equality',
    ' ❯ tests/m8/app-shell-ux.test.ts:444:43',
    ...Array.from({ length: 400 }, (_, index) => `    concurrent worker output ${index} `.padEnd(140, 'x')),
  ].join('\n');
  const rsi = service(root, dir, async () => [
    { command: 'node --run check', status: 'failed' as const, output: interleaved },
  ]);
  const failed = await rsi.apply({
    title: 'Broken change',
    problem: 'Introduce a regression.',
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 42;\n' }],
  }, { store, taskId, conversationId });
  expect(failed.status).toBe('checks_failed');
  expect(failed.report).toContain('失败摘要');
  expect(failed.report).toContain('app-shell-ux.test.ts:444:43');
  expect(failed.report).toContain('AssertionError');
  expect(failed.report.length).toBeLessThan(8_000);
});

test('an unavailable root is reported to the user instead of thrown', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'graph-rsi-state-'));
  cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
  const { store, taskId, conversationId } = ledger();
  const receipt = await new RsiService({ stateDir, validate: passing }).apply({
    title: 'No checkout',
    problem: 'Nothing to change.',
    changes: [{ path: 'a.ts', action: 'write', content: 'x' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('unavailable');
  expect(receipt.report).toContain('RSI 不可用');
  expect((await new RsiService({ stateDir, validate: passing }).status()).reason).toContain('GRAPH_RSI_ROOT');
});

test('ackRestart clears only the matching request id', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const receipt = await rsi.apply({
    title: 'Pending',
    problem: 'Needs a reload.',
    changes: [{ path: 'src/one.ts', action: 'write', content: '1\n' }],
  }, { store, taskId, conversationId });
  expect((await rsi.status()).pendingRestart?.id).toBe(receipt.id);
  expect((await rsi.ackRestart('other', store)).cleared).toBe(false);
  expect((await rsi.ackRestart(receipt.id, store)).cleared).toBe(false);
  const restarted = service(root, dir);
  expect((await restarted.ackRestart(receipt.id, store)).cleared).toBe(false);
  store.db.prepare('UPDATE runtime SET generation=generation+1').run();
  expect((await restarted.ackRestart(receipt.id, store)).cleared).toBe(true);
  expect((await restarted.ackRestart(receipt.id, store)).cleared).toBe(false);
  expect((await restarted.status()).lastActivation).toMatchObject({ id: receipt.id, commit: receipt.commit });
  const message = store.db.prepare("SELECT data,text FROM messages WHERE kind='rsi'").get() as { data: string; text: string };
  expect(JSON.parse(message.data)).toMatchObject({ activation: { state: 'active' } });
  expect(message.text).toContain('重载已确认');
  expect((store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='rsi.activated'").get() as { n: number }).n).toBe(1);
  expect((await rsi.status()).pendingRestart).toBeNull();
  expect(existsSync(join(dir, 'rsi', 'restart.json'))).toBe(false);
});

test('a pending reload cannot be replaced by another RSI change', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  const context = { store, taskId, conversationId };
  const first = await rsi.apply({ title: 'First', problem: 'First change', changes: [{ path: 'first.ts', action: 'write', content: 'export {};\n' }], activate: true }, context);
  await expect(rsi.apply({ title: 'Second', problem: 'Must wait', changes: [{ path: 'src/keep.ts', action: 'write', content: 'overwritten' }] }, context)).rejects.toThrow('waiting for reload');
  expect((await rsi.status()).pendingRestart?.id).toBe(first.id);
  expect(await readFile(join(root, 'src/keep.ts'), 'utf8')).toBe('export const value = 1;\n');
  expect(shell(root, ['status', '--porcelain'])).toBe('');
});

test('resolveRsiRoot prefers an explicit GRAPH_RSI_ROOT', async () => {
  const root = await repo();
  const real = await realpath(root);
  expect(resolveRsiRoot({ GRAPH_RSI_ROOT: root }, '/nowhere')).toBe(real);
  expect(resolveRsiRoot({}, root)).toBe(real);
  // With no usable cwd it falls back to the running Graph checkout.
  expect(resolveRsiRoot({}, '/nowhere')).toBe(await realpath(graphApplicationRoot()));
});

test('status counts running operations so a reload can wait', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  store.db.prepare('INSERT INTO nodes(task_id,id,spec,status) VALUES(?,?,?,?)').run(taskId, 'master', '{}', 'running');
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES(?,?,?,?,?,?,?,?)`).run('op1', taskId, 'master', 0, '{}', 'dispatched', 0, 0);
  const rsi = service(root, dir);
  await rsi.apply({ title: 'Wait for other work', problem: 'Reload without interrupting it', changes: [{ path: 'next.ts', action: 'write', content: 'export {};\n' }] }, { store, taskId, conversationId });
  const status = await rsi.status();
  expect(status.activeOperations).toBe(1);
  expect(status.operations).toEqual([{
    id: 'op1',
    taskId,
    nodeId: 'master',
    state: 'dispatched',
    request: 'improve graph',
    conversationId,
    archived: false,
  }]);
  expect(status.canRestart).toBe(false);
  store.db.prepare("UPDATE operations SET state='succeeded' WHERE id='op1'").run();
  expect((await rsi.status()).canRestart).toBe(true);
});

test('a forced change reloads even with operations still running', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  store.db.prepare('INSERT INTO nodes(task_id,id,spec,status) VALUES(?,?,?,?)').run(taskId, 'master', '{}', 'running');
  store.db.prepare(`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved,worker_active)
    VALUES(?,?,?,?,?,?,?,?)`).run('op1', taskId, 'master', 0, '{}', 'dispatched', 0, 0);
  const rsi = service(root, dir);
  const receipt = await rsi.apply({
    title: 'Force the reload',
    problem: 'Must go live now.',
    force: true,
    changes: [{ path: 'src/forced.ts', action: 'write', content: 'export const forced = true;\n' }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect(receipt.force).toBe(true);
  const restart = JSON.parse(await readFile(join(dir, 'rsi', 'restart.json'), 'utf8')) as { force: boolean };
  expect(restart.force).toBe(true);
  const status = await rsi.status();
  expect(status.activeOperations).toBe(1);
  expect(status.canRestart).toBe(true);
});

test('a large file is accepted because only the report is bounded', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const content = `export const blob = '${'x'.repeat(3 * 1024 * 1024)}';\n`;
  const receipt = await service(root, dir).apply({
    title: 'Add a large file',
    problem: 'The file is genuinely large.',
    changes: [{ path: 'src/blob.ts', action: 'write', content }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('applied');
  expect((await stat(join(root, 'src', 'blob.ts'))).size).toBeGreaterThan(3 * 1024 * 1024);
  // The report diff is truncated, but the file itself is intact.
  expect(receipt.diff?.length ?? 0).toBeLessThanOrEqual(40_000 + 200);
});

test('custom checks give a fast inner loop without running the full gate', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-rsi-checks-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  shell(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'package.json'), JSON.stringify({
    name: 'graph', scripts: { check: 'node -e "process.exit(1)"', ok: 'node -e "process.exit(0)"' },
  }, null, 2));
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'init']);
  const { store, taskId, conversationId, dir } = ledger();
  // No mock validate: this exercises the real default check ladder.
  const rsi = new RsiService({ root, stateDir: dir });
  const fast = await rsi.apply({
    title: 'Fast inner loop',
    problem: 'Iterate quickly.',
    activate: false,
    changes: [{ path: 'note.md', action: 'write', content: 'hello\n' }],
    checks: [{ command: 'node', args: ['--run', 'ok'] }],
  }, { store, taskId, conversationId });
  expect(fast.status).toBe('applied');
  expect(fast.validation.map(item => item.command)).toEqual(['node --run ok']);

  // Without a custom check the full gate runs and fails.
  const gated = await rsi.apply({
    title: 'Full gate',
    problem: 'The repo check is broken.',
    activate: false,
    changes: [{ path: 'note2.md', action: 'write', content: 'hello\n' }],
  }, { store, taskId, conversationId });
  expect(gated.status).toBe('checks_failed');
  expect(gated.validation.map(item => item.command)).toEqual(['node --run check']);
});

test('a green check refuses to verify a checkout whose changes the commit would miss', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  // Someone edited a file by hand: the checks would cover it, the commit would not.
  await writeFile(join(root, 'src/keep.ts'), 'export const value = 9;\n');
  await expect(service(root, dir).apply({
    title: 'Checks-only re-run',
    problem: 'Re-run the gate.',
    activate: false,
    changes: [],
    checks: [{ command: 'node', args: ['--run', 'check'] }],
  }, { store, taskId, conversationId })).rejects.toThrow(/Uncommitted changes outside this RSI change/);
  expect(shell(root, ['log', '--oneline']).split('\n')).toHaveLength(1);
  expect(await readFile(join(root, 'src/keep.ts'), 'utf8')).toBe('export const value = 9;\n');
});

test('a rolled-back attempt leaves no index entry behind, so the next attempt is not blocked by its own debris', async () => {
  const root = await repo();
  await writeFile(join(root, '.gitignore'), 'scratch/\n');
  shell(root, ['add', '-A']);
  shell(root, ['commit', '-m', 'ignore scratch']);
  const { store, taskId, conversationId, dir } = ledger();
  const rsi = service(root, dir);
  // `git add -A -- good ignored` stages the good path and then fails on the ignored one, which is how a
  // failed attempt leaves a staged entry behind. Restoring the files is not enough: the index entry is
  // what the next attempt reads as somebody else's uncommitted work.
  const blocked = await rsi.apply({
    title: 'Mixed staging',
    problem: 'One change lands on an ignored path.',
    activate: false,
    changes: [
      { path: 'src/fresh.ts', action: 'write', content: 'export const fresh = 1;\n' },
      { path: 'scratch/ignored.ts', action: 'write', content: 'export const ignored = 1;\n' },
    ],
  }, { store, taskId, conversationId });
  expect(blocked.status).toBe('rolled_back');
  expect(shell(root, ['status', '--porcelain'])).toBe('');

  const next = await rsi.apply({
    title: 'Clean retry',
    problem: 'The failed attempt must not block the fix.',
    activate: false,
    changes: [{ path: 'src/fresh.ts', action: 'write', content: 'export const fresh = 2;\n' }],
  }, { store, taskId, conversationId });
  expect(next.status).toBe('applied');
});

test('a check that dirties the checkout does not become a verified commit', async () => {
  const root = await repo();
  const { store, taskId, conversationId, dir } = ledger();
  const dirtying = async (): Promise<RsiValidationResult[]> => {
    await writeFile(join(root, 'src/junk.ts'), 'export const junk = 1;\n');
    return [{ command: 'mock check', status: 'passed', output: '' }];
  };
  const receipt = await service(root, dir, dirtying).apply({
    title: 'Dirty check',
    problem: 'A check writes a file.',
    activate: false,
    changes: [{ path: 'src/keep.ts', action: 'write', content: 'export const value = 5;\n' }],
    checks: [{ command: 'node', args: ['--eval', 'true'] }],
  }, { store, taskId, conversationId });
  expect(receipt.status).toBe('rolled_back');
  expect(String(receipt.error)).toContain('Uncommitted changes outside this RSI change');
  expect(shell(root, ['log', '--oneline']).split('\n')).toHaveLength(1);
});
