import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function checkout() {
  const root = await mkdtemp(join(tmpdir(), 'graph-baseline-e2e-'));
  roots.push(root);
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'tests'));
  // The executable resolves files beside itself. Copy it unchanged so a rejection
  // cannot touch the working checkout's report or committed baseline.
  const script = join(root, 'scripts/check-test-baseline.mjs');
  await copyFile(new URL('../../scripts/check-test-baseline.mjs', import.meta.url), script);
  const baseline = join(root, 'tests/suite-baseline.json');
  const report = join(root, 'tests/.suite-report.json');
  return {
    baseline, report,
    async record(files: number, tests: number) {
      await writeFile(report, JSON.stringify({ testResults: Array.from({ length: files }, () => ({})), numTotalTests: tests }));
    },
    async run(update = false) {
      const env = { ...process.env };
      delete env.GRAPH_UPDATE_BASELINE;
      if (update) env.GRAPH_UPDATE_BASELINE = '1';
      try {
        const output = await execute(process.execPath, [script], { cwd: root, env });
        return { code: 0, ...output };
      } catch (error) {
        const failure = error as { code: number; stdout: string; stderr: string };
        return { code: failure.code, stdout: failure.stdout, stderr: failure.stderr };
      }
    },
    async counts() { return JSON.parse(await readFile(baseline, 'utf8')) as { files: number; tests: number; updatedAt: string }; },
  };
}

test('the gate initializes, records suite growth and leaves an unchanged baseline untouched', async () => {
  const gate = await checkout();
  await gate.record(1, 1);
  expect(await gate.run()).toMatchObject({ code: 0, stdout: expect.stringContaining('No suite baseline') });
  expect(await gate.counts()).toMatchObject({ files: 1, tests: 1, updatedAt: expect.stringMatching(/^\d{4}-/) });
  await gate.record(2, 3);
  expect(await gate.run()).toMatchObject({ code: 0, stdout: expect.stringContaining('increased') });
  expect(await gate.counts()).toMatchObject({ files: 2, tests: 3 });
  const saved = await readFile(gate.baseline, 'utf8');
  expect(await gate.run()).toMatchObject({ code: 0, stdout: expect.stringContaining('matches') });
  expect(await readFile(gate.baseline, 'utf8')).toBe(saved);
});

test('losing files or cases rejects without rewriting until an intentional reduction is requested', async () => {
  const gate = await checkout();
  await gate.record(240, 1622);
  expect((await gate.run()).code).toBe(0);
  const saved = await readFile(gate.baseline, 'utf8');
  for (const [files, tests, delta] of [[239, 1622, '1 file(s)'], [240, 1609, '13 test(s)']] as const) {
    await gate.record(files, tests);
    const rejected = await gate.run();
    expect(rejected.code).toBe(1);
    expect(rejected.stderr).toContain(delta);
    expect(await readFile(gate.baseline, 'utf8')).toBe(saved);
  }
  const accepted = await gate.run(true);
  expect(accepted.code).toBe(0);
  expect(accepted.stdout).toContain('GRAPH_UPDATE_BASELINE=1: baseline lowered');
  expect(await gate.counts()).toMatchObject({ files: 240, tests: 1609 });
});

test('a missing suite report or malformed baseline cannot become a successful check', async () => {
  const gate = await checkout();
  const missing = await gate.run();
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain('No suite report');
  await expect(readFile(gate.baseline, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  await gate.record(1, 1);
  const malformed = JSON.stringify({ files: 'many', tests: null });
  await writeFile(gate.baseline, malformed);
  for (const update of [false, true]) {
    const refused = await gate.run(update);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain('baseline is malformed');
    expect(await readFile(gate.baseline, 'utf8')).toBe(malformed);
  }
});
