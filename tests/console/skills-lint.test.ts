import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, expect, test } from 'vitest';

/**
 * The skills linter is advisory: it warns about the shape of a skill we wrote ourselves and never
 * blocks a write. These cases run the real script over real directories, so the assertions are
 * about what a caller sees (stdout and exit code), not about internal helpers.
 */

const run = promisify(execFile);
const SCRIPT = join(process.cwd(), 'scripts/skills-lint.mjs');

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function root() {
  const dir = await mkdtemp(join(tmpdir(), 'graph-skills-lint-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Write one skill under `<root>/.agents/skills/<id>/`. */
async function skill(base: string, id: string, options: {
  frontmatter?: string;
  body?: string;
  references?: string[];
} = {}) {
  const dir = join(base, '.agents', 'skills', id);
  await mkdir(dir, { recursive: true });
  const frontmatter = options.frontmatter
    ?? `name: ${id}\ndescription: Do the ${id} thing repeatedly. Use when the task needs it.`;
  const body = options.body ?? '\n## Procedure\n\n1. Do the thing.\n';
  await writeFile(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
  for (const name of options.references ?? []) {
    await mkdir(join(dir, 'references'), { recursive: true });
    await writeFile(join(dir, 'references', name), 'note\n');
  }
}

const AUTHORED = 'created-by: graph-agent';

/** Run the linter against a project root, a skills container, or both. */
async function lintAt(flag: string, base: string, extra: string[] = []) {
  try {
    const { stdout } = await run('node', [SCRIPT, flag, base, '--json', ...extra], { cwd: process.cwd() });
    return { report: JSON.parse(stdout) as LintReport, code: 0 };
  } catch (cause) {
    const failure = cause as { code?: number; stdout?: string };
    return { report: JSON.parse(failure.stdout ?? '{}') as LintReport, code: failure.code ?? 1 };
  }
}

function lint(base: string, extra: string[] = []) {
  return lintAt('--root', base, extra);
}

interface LintWarning { rule: string; message: string }
interface LintReport { skills: { id: string; path: string; warnings: LintWarning[] }[]; summary: { skills: number; warnings: number } }

/** The rule ids reported for one skill, so a case can assert exactly what fired. */
function rules(report: LintReport, id: string) {
  return (report.skills.find(item => item.id === id)?.warnings ?? []).map(warning => warning.rule).sort();
}

test('a conforming authored skill produces no warnings and exits zero under --strict', async () => {
  const base = await root();
  await skill(base, 'good-one', { frontmatter: `name: good-one\n${AUTHORED}\ndescription: Rebuild the search index safely. Use when the index is corrupt.` });

  const { report, code } = await lint(base, ['--strict']);

  expect(rules(report, 'good-one')).toEqual([]);
  expect(report.summary.warnings).toBe(0);
  expect(code).toBe(0);
});

test('each hard rule fires on its own sample', async () => {
  const base = await root();
  await skill(base, 'no-frontmatter', { frontmatter: AUTHORED });
  await skill(base, 'name-mismatch', { frontmatter: `name: something-else\n${AUTHORED}\ndescription: Do it. Use when needed.` });
  await skill(base, 'long-description', { frontmatter: `name: long-description\n${AUTHORED}\ndescription: ${'x'.repeat(320)}` });
  await skill(base, 'huge-body', { frontmatter: `name: huge-body\n${AUTHORED}\ndescription: Do it. Use when needed.`, body: 'y'.repeat(24_500) });
  await skill(base, 'many-refs', {
    frontmatter: `name: many-refs\n${AUTHORED}\ndescription: Do it. Use when needed.`,
    references: Array.from({ length: 61 }, (_, index) => `topic-${index}.md`),
  });
  await skill(base, 'incident-ref', {
    frontmatter: `name: incident-ref\n${AUTHORED}\ndescription: Do it. Use when needed.`,
    references: ['2026-09-26-outage.md'],
  });

  const { report } = await lint(base, ['--strict']);

  expect(rules(report, 'no-frontmatter')).toContain('missing-frontmatter');
  expect(rules(report, 'name-mismatch')).toContain('name-mismatch');
  expect(rules(report, 'long-description')).toContain('description-too-long');
  expect(rules(report, 'huge-body')).toContain('oversized-body');
  expect(rules(report, 'many-refs')).toContain('references-sprawl');
  expect(rules(report, 'incident-ref')).toContain('references-incident-named');
});

test('the advisory rules fire on an authored skill', async () => {
  const base = await root();
  await skill(base, 'vague-description', {
    frontmatter: `name: vague-description\n${AUTHORED}\ndescription: A helper for working with the thing.`,
  });
  await skill(base, 'incident-body', {
    frontmatter: `name: incident-body\n${AUTHORED}\ndescription: Do it. Use when needed.`,
    body: '\nFixed in #12345 after 2026-09-01 regressed. Also #22345, #32345 and #42345.\n',
  });

  const { report } = await lint(base);

  expect(rules(report, 'vague-description')).toEqual(['description-not-triggering']);
  expect(rules(report, 'incident-body')).toEqual(['incident-log-shape']);
});

test('a skill we did not author is out of scope, and --all only adds the hard rules', async () => {
  const base = await root();
  await skill(base, 'imported-vague', {
    frontmatter: 'name: imported-vague\ndescription: A helper for working with the thing.',
    body: '\nFixed in #12345, #22345, #32345 and #42345.\n',
  });

  const scoped = await lint(base, ['--strict']);
  expect(rules(scoped.report, 'imported-vague')).toEqual([]);
  expect(scoped.code).toBe(0);

  const all = await lint(base, ['--all', '--strict']);
  expect(rules(all.report, 'imported-vague')).not.toContain('description-not-triggering');
  expect(rules(all.report, 'imported-vague')).not.toContain('incident-log-shape');
  expect(all.report.summary.skills).toBe(1);
});

test('the repository ships a conforming authored fixture and lints it clean', async () => {
  const fixture = join(process.cwd(), 'tests/fixtures/skills/good');
  const { report, code } = await lintAt('--skills', fixture, ['--strict']);

  expect(report.summary.skills).toBeGreaterThan(0);
  expect(report.summary.warnings).toBe(0);
  expect(code).toBe(0);
});
