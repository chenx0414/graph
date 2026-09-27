import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { injectRequestedSkills, requestedSkillNames, SKILL_BODY_LIMIT } from '../../src/core/skill-invocation.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.splice(0)) await action(); });

async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-skill-invocation-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function skill(root: string, name: string, body: string) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\n---\n\n${body}`);
  return { name, path, version: '1.0.0' };
}

test('only a spelled-out /skill token counts, and the body arrives without its front matter', async () => {
  const root = await temp('basic');
  const toSpec = await skill(root, 'to-spec', '# Spec\n\nWrite the spec file.\n');
  const plain = await injectRequestedSkills('把 /skill:to-spec 用上', [toSpec]);
  expect(plain.injected).toEqual(['to-spec']);
  expect(plain.text).toContain('<skill name="to-spec" version="1.0.0">');
  expect(plain.text).toContain('Write the spec file.');
  expect(plain.text).not.toContain('name: to-spec');

  // A mention without the token is just prose, and a path-looking string is not a skill.
  expect(requestedSkillNames('/skills/to-spec and to-spec')).toEqual([]);
  expect(requestedSkillNames('看 /skill:to-spec 与 /skill:to-tickets')).toEqual(['to-spec', 'to-tickets']);
  const untouched = await injectRequestedSkills('没有选择任何技能', [toSpec]);
  expect(untouched.text).toBe('没有选择任何技能');
  expect(untouched.injected).toEqual([]);
});

test('a skill that cannot be injected is reported, never skipped silently', async () => {
  const root = await temp('missing');
  const good = await skill(root, 'good', 'ok');
  const broken = { name: 'broken', path: join(root, 'not-here'), version: '1.0.0' };
  const result = await injectRequestedSkills('用 /skill:good /skill:broken /skill:unbound', [good, broken]);
  expect(result.injected).toEqual(['good']);
  expect(result.rejected).toEqual([
    { name: 'broken', reason: `body unreadable at ${join(root, 'not-here')}` },
    { name: 'unbound', reason: 'not bound to this Agent' },
  ]);
  expect(result.text).toContain('Not injected: `broken` (body unreadable');
  expect(result.text).toContain('`unbound` (not bound to this Agent)');
  // A rejected name must never look like it was read.
  expect(result.text).not.toContain('<skill name="broken"');
});

test('an oversized body is clipped and says so rather than crowding out the turn', async () => {
  const root = await temp('oversized');
  const huge = await skill(root, 'huge', 'x'.repeat(SKILL_BODY_LIMIT + 500));
  const result = await injectRequestedSkills('用 /skill:huge', [huge]);
  expect(result.injected).toEqual(['huge']);
  expect(result.text).toContain('[truncated: the body is');
  expect(result.text).toContain('characters and only the first');
  expect(result.text).toContain(`${SKILL_BODY_LIMIT.toLocaleString('en-US')} were injected`);
  expect(result.text.length).toBeLessThan(SKILL_BODY_LIMIT + 1_000);
});

test('the names a turn asked for can be given explicitly, so an older turn is not re-read', async () => {
  const root = await temp('explicit');
  const body = await skill(root, 'demo', 'marker');
  const text = 'Request: /skill:demo\nUser messages:\n- /skill:dashboard 看一下';
  // Scanning this text would pick up both, which is exactly the bug when a briefing keeps history.
  expect(requestedSkillNames(text)).toEqual(['demo', 'dashboard']);
  const result = await injectRequestedSkills(text, [body], ['dashboard']);
  expect(result.injected).toEqual([]);
  expect(result.rejected).toEqual([{ name: 'dashboard', reason: 'not bound to this Agent' }]);
  expect(result.text).not.toContain('marker');
});
