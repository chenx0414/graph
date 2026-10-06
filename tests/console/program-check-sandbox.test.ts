// Where a program check runs, pinned as behaviour (R24: failure modes first).
//
// Failure mode this file exists for: the confirmed gate that runs the project's own suite could not
// finish inside the OS sandbox. Measured 2026-09-30 on task 68543fed, same copy and same
// `node --run check`: outside the sandbox 1480/1480 passed, inside it 224 failed / 49 passed, mostly
// the suite's own 15s timeouts - the sandbox makes every child process slow enough that the suite
// fails for reasons that have nothing to do with the work. A gate nobody can trust is not a gate.
//
// So `workspace.command` modules may declare `sandbox: false`, which runs the command outside the seatbelt. The
// declaration is honoured ONLY under full access - the command comes from the confirmed graph, and
// under full access an Agent can already run host commands; anything less must refuse rather than
// quietly downgrade.
//
// Leaving the sandbox lifts containment, NOT what the command is allowed to see. The first version
// of this ran the check with the host's whole environment, which handed it the app's own provider
// credentials, the path of the live checkout, and a PATH without the toolchain - so the environment
// is now built from a short allowlist plus whatever the host declared for checks. Both halves are
// pinned below.
//
// 1. Under standard access a `sandbox: false` check is refused, and the refusal says why.
// 2. Under full access it really runs outside the sandbox: the containment the sandbox imposes is
//    gone, which shows up in where the run is allowed to put its temporary files.
// 3. Declaring nothing keeps the old behaviour: sandboxed.
// 4. Neither run is handed the app's own environment (its `GRAPH_*` secrets).
// 5. The record says which way it ran, so evidence carries its own shape.

import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { runWorkspaceCheck, workspaceCheckOutput } from '../fixtures/workspace-check.ts';
import { git as runGit } from '../../src/git/git.ts';
import { checkEnvironment } from '../../src/runtime/host-command.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

/** A credential the app's own environment carries and a check must never be handed. */
const SECRET = 'GRAPH_SUBSCRIPTION_PROBE_API_KEY';

function git(cwd: string, args: string[]) {
  const result = runGit(cwd, args);
  if (result.code !== 0) throw new Error(result.stderr);
  return result.stdout;
}

async function repo() {
  const root = await mkdtemp(join(tmpdir(), 'graph-check-sandbox-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  git(root, ['init', '-b', 'main']);
  await writeFile(join(root, 'README.md'), 'project\n');
  git(root, ['add', '.']);
  git(root, ['commit', '-m', 'init']);
  return root;
}

/**
 * Reports the two facts this file is about, both of which are decided in code and read back from the
 * durable record: where the check was allowed to keep its temporary files, and what of the host's
 * environment reached it.
 *
 * The temp directory is the observable half of containment. A sandboxed check may write only under
 * its work copy and its scratch, so the harness hands it a TMPDIR inside the work copy; an
 * unsandboxed one runs with the host's. Note what this does NOT claim: under full access the sandbox
 * profile already permits everything (host filesystem, unrestricted network, unix sockets, Apple
 * events), so there is no withheld capability left to demonstrate - the sandbox was costing a working
 * gate without buying authority, which is why the declaration exists.
 */
const PROBE_SCRIPT = [
  "console.log('tmp=' + (process.env.TMPDIR ?? 'none') + ' secret=' + (process.env[" + JSON.stringify(SECRET) + "] ?? 'absent'));",
  '',
].join('\n');

async function run(root: string, input: unknown, options: { fullAccess?: boolean } = {}) {
  await mkdir(join(root, 'scripts'), { recursive: true });
  await writeFile(join(root, 'scripts', 'probe.mjs'), PROBE_SCRIPT);
  const checked = await runWorkspaceCheck({ workspace: root, command: input, ...options });
  cleanup.push(() => checked.runtime.close());
  return checked;
}

/** Failure audit remains readable even when authority refused dispatch and no operation exists. */
async function refusal(view: Awaited<ReturnType<typeof run>>) {
  const store = new TaskStore(join(view.root, 'state', 'tasks.sqlite'));
  const row = store.db.prepare("SELECT data FROM events WHERE task_id=? AND type='graph.module.failed' ORDER BY cursor DESC LIMIT 1")
    .get(view.graphId) as { data: string } | undefined;
  store.close();
  return row ? JSON.parse(row.data) as { reason?: string } : undefined;
}

async function recordBody(view: Awaited<ReturnType<typeof run>>) {
  const output = await workspaceCheckOutput(view);
  return JSON.parse(await readFile(output.record, 'utf8')) as { code: number; stdout: string; sandboxed: boolean };
}

test('under standard access, asking to run outside the sandbox is refused and says why', async () => {
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], sandbox: false });
  expect(await view.main.graphInspect({ graphId: view.graphId, query: 'operations' })).toEqual([]);
  // A silent downgrade would be worse than a refusal: the author would believe the check ran the way
  // it was written. The message has to name the missing precondition.
  const said = await refusal(view);
  expect(said?.reason).toMatch(/full access/);
});

test('under full access it really runs outside the sandbox, and the record says so', async () => {
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], sandbox: false }, { fullAccess: true });
  expect((await recordBody(view)).code).toBe(0);
  const body = await recordBody(view);
  // Outside the sandbox the check runs with the host's temporary directory, not one carved out of its
  // operation scratch, and the record says which way it ran.
  expect(body.stdout).toContain(`tmp=${process.env['TMPDIR'] ?? 'none'}`);
  expect(body.stdout).not.toContain(`tmp=${root}`);
  expect(body.sandboxed).toBe(false);
});

test.each([false, true])('declaring nothing keeps a dedicated sandbox scratch under fullAccess=%s', async fullAccess => {
  const root = await repo();
  const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'] }, { fullAccess });
  expect((await recordBody(view)).code).toBe(0);
  const body = await recordBody(view);
  // A sandboxed check gets an operation-specific temporary directory, including under full access.
  // Both sides through realpath: macOS tmpdirs are reached through /private, and comparing an
  // unresolved path with a resolved one passes on one machine and fails on the next.
  const output = await workspaceCheckOutput(view);
  expect(body.stdout).toContain(`tmp=${realpathSync(dirname(output.record))}`);
  expect(body.sandboxed).toBe(true);
});

test('the environment a check runs with is built, not inherited', () => {
  // The allowlist is the whole difference between "runs like the project" and "runs with everything
  // the app has". Measured 2026-09-30: inheriting it handed the check a real provider key, the path of
  // the live checkout, and a PATH without the toolchain (a GUI-launched app gets /usr/bin:/bin only).
  const env = checkEnvironment({
    executable: '/usr/bin/node',
    declared: { TMPDIR: '/declared/tmp' },
    host: {
      PATH: '/usr/bin:/bin', HOME: '/Users/somebody', TMPDIR: '/host/tmp',
      GRAPH_SUBSCRIPTION_X_API_KEY: 'oc_sk_a_real_looking_key', ELECTRON_RUN_AS_NODE: '1', GRAPH_RSI_ROOT: '/live/checkout',
    },
  });
  expect(env['PATH']!.split(':')).toEqual(expect.arrayContaining(['/usr/bin', '/bin', '/opt/homebrew/bin', '/usr/local/bin']));
  expect(env['HOME']).toBe('/Users/somebody');
  // What the host declared for checks wins, including the temp directory.
  expect(env['TMPDIR']).toBe('/declared/tmp');
  for (const leaked of ['GRAPH_SUBSCRIPTION_X_API_KEY', 'ELECTRON_RUN_AS_NODE', 'GRAPH_RSI_ROOT']) {
    expect(Object.keys(env), leaked).not.toContain(leaked);
  }
});

test('a check is not handed the app own environment, sandboxed or not', async () => {
  // Measured 2026-09-30: the first version of this ran the check with process.env inherited, which
  // handed a real provider key to the check and to everything it spawned. The app's environment is
  // not the check's environment; only the allowlist a toolchain needs travels.
  process.env[SECRET] = 'oc_sk_not_for_checks';
  cleanup.push(async () => { delete process.env[SECRET]; });
  for (const sandbox of [true, false]) {
    const root = await repo();
    const view = await run(root, { command: 'node', args: ['scripts/probe.mjs'], ...(sandbox ? {} : { sandbox: false }) }, { fullAccess: true });
    expect((await recordBody(view)).code).toBe(0);
    const body = await recordBody(view);
    expect(body.stdout, `sandboxed=${String(sandbox)}`).toContain('secret=absent');
  }
});

test('a sandbox declaration that is not a boolean is refused rather than guessed at', async () => {
  const root = await repo();
  await expect(run(root, { command: 'node', args: ['scripts/probe.mjs'], sandbox: 'no' }, { fullAccess: true })).rejects.toThrow(/sandbox must be boolean/);
});
