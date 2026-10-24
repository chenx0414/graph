import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { DEFAULT_COMMON_RULES } from '../../src/runtime/agent-context.ts';

const execute = promisify(execFile);
const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** The gate as the check pipeline runs it, with the exit code kept. */
async function runGate(env: Record<string, string>) {
  try {
    const { stdout, stderr } = await execute(process.execPath, ['scripts/harness-behavior-gate.mjs'], {
      cwd: process.cwd(), timeout: 240000, env: { ...process.env, ...env },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

test('the harness behavior gate judges the frozen cases, and names what a broken harness took away', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-harness-gate-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  // The gate the way the check pipeline runs it: every frozen case is carried
  // out against the harness the product ships, and the case's own independent
  // check decides whether the work came out right.
  const green = await runGate({ GRAPH_HARNESS_GATE_STATE: join(root, 'state.json') });
  expect(green.code).toBe(0);
  expect(green.output).toContain('harness behavior gate passed');
  for (const caseId of ['parser', 'cli', 'persistence', 'command']) {
    expect(green.output).toContain(`${caseId}: pass`);
  }
  // The judged surface is recorded, so the next harness change is visible.
  const state = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as { cases: Record<string, string>; surface: Record<string, string> };
  expect(Object.keys(state.cases)).toEqual(['parser', 'cli', 'persistence', 'command']);
  expect(Object.keys(state.cases).every(caseId => state.cases[caseId] === 'pass')).toBe(true);
  expect(state.surface['src/runtime/agent-context.ts']).toMatch(/^[0-9a-f]{64}$/);

  // A harness that no longer says how to make a precise change leaves the
  // agent without a way to act. The gate has to see that and say so.
  const context = join(root, 'context');
  await mkdir(join(context, 'prompts', 'rules'), { recursive: true });
  await writeFile(join(context, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{ id: 'main', mode: 'main', name: 'Main', description: 'Handle the requested project work.', recommendedGrade: 'high', review: false, tags: [], resources: [] }],
  }));
  const doctored = DEFAULT_COMMON_RULES.split('\n').filter((rule) => !rule.includes('Use edit for precise changes')).join('\n');
  expect(doctored).not.toContain('Use edit for precise changes');
  await writeFile(join(context, 'prompts', 'rules', 'common.md'), `${doctored}\n`);
  const snapshot = join(root, 'snapshot');
  await execute(process.execPath, ['scripts/harness-eval-context.mjs', context, snapshot], { cwd: process.cwd(), timeout: 120000 });

  const red = await runGate({ GRAPH_HARNESS_GATE_STATE: join(root, 'state.json'), GRAPH_HARNESS_GATE_SNAPSHOT: snapshot });
  expect(red.code).not.toBe(0);
  expect(red.output).toContain('harness behavior gate failed');
  // The failure names the rule the harness no longer carries, and says that a
  // case which used to pass is the one that broke.
  expect(red.output).toContain('Use edit for precise changes');
  expect(red.output).toContain('regressed');
  // A failing run records nothing: the judged surface and the verdicts stay
  // as they were.
  const afterFailure = JSON.parse(await readFile(join(root, 'state.json'), 'utf8')) as { cases: Record<string, string> };
  expect(Object.keys(afterFailure.cases).every(caseId => afterFailure.cases[caseId] === 'pass')).toBe(true);
}, 600_000);
