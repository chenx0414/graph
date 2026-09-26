import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { promoteProjectSkill } from '../../src/runtime/skill-promotion.ts';

/**
 * Promotion is a copy with a manifest, so the cases pin what a caller gets: the files, the declared
 * provenance, an idempotent second run, and a version that moves only when the content does.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture(body = '# Heartbeat check\n\n1. Confirm the pid is alive.\n') {
  const root = await mkdtemp(join(tmpdir(), 'graph-skill-promotion-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const capabilities = join(root, 'capabilities');
  const skill = join(project, '.agents', 'skills', 'heartbeat-check');
  await mkdir(join(skill, 'references'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), [
    '---',
    'name: heartbeat-check',
    'created-by: graph-agent',
    'description: Verify a service is still answering before blaming the code. Use when a process stops responding.',
    '---',
    '',
    body,
  ].join('\n'));
  await writeFile(join(skill, 'references', 'probe.md'), 'topic note\n');
  return { project, capabilities, skill };
}

test('a promoted skill arrives in the library with its files and a manifest', async () => {
  const { project, capabilities } = await fixture();

  const result = promoteProjectSkill({ projectRoot: project, skillId: 'heartbeat-check', capabilityRoot: capabilities });

  const dir = join(capabilities, 'skills', 'heartbeat-check');
  const manifest = JSON.parse(await readFile(join(dir, 'capability.json'), 'utf8')) as Record<string, string>;
  expect(result.promoted).toMatchObject({ id: 'heartbeat-check', replaced: false });
  expect(result.promoted.path).toBe(dir);
  expect(await readFile(join(dir, 'SKILL.md'), 'utf8')).toContain('Confirm the pid is alive');
  expect(await readFile(join(dir, 'references', 'probe.md'), 'utf8')).toBe('topic note\n');
  expect(manifest).toMatchObject({
    id: 'heartbeat-check',
    kind: 'skill',
    name: 'heartbeat-check',
    source: 'graph:project',
    createdBy: 'graph-agent',
    promotedFrom: '.agents/skills/heartbeat-check',
  });
  expect(manifest.version).toMatch(/^[0-9a-f]{12}$/);
  expect(result.bindHint).toContain('agent-recipes.md');
});

test('promoting the same content twice changes nothing, and new content moves the version', async () => {
  const first = await fixture();
  const initial = promoteProjectSkill({ projectRoot: first.project, skillId: 'heartbeat-check', capabilityRoot: first.capabilities });

  const again = promoteProjectSkill({ projectRoot: first.project, skillId: 'heartbeat-check', capabilityRoot: first.capabilities });
  expect(again.promoted.version).toBe(initial.promoted.version);
  expect(again.promoted.replaced).toBe(false);

  await writeFile(join(first.skill, 'SKILL.md'), (await readFile(join(first.skill, 'SKILL.md'), 'utf8')) + '\n2. Then look at the code.\n');
  const changed = promoteProjectSkill({ projectRoot: first.project, skillId: 'heartbeat-check', capabilityRoot: first.capabilities });
  expect(changed.promoted.replaced).toBe(true);
  expect(changed.promoted.version).not.toBe(initial.promoted.version);
});

test('a skill without a usable front matter is refused with a readable error', async () => {
  const { project, capabilities, skill } = await fixture();
  await writeFile(join(skill, 'SKILL.md'), '# no front matter\n');

  expect(() => promoteProjectSkill({ projectRoot: project, skillId: 'heartbeat-check', capabilityRoot: capabilities }))
    .toThrow(/description/);
  expect(() => promoteProjectSkill({ projectRoot: project, skillId: 'missing-skill', capabilityRoot: capabilities }))
    .toThrow(/missing-skill/);
});
