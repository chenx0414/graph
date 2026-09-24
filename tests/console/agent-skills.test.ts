import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { agentSkills, agentSkillsDir, syncAgentSkills } from '../../src/runtime/agent-skills.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

const frontmatter = (name: string, description: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

async function skillDir(parent: string, id: string, name: string, description: string) {
  const dir = join(parent, id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), frontmatter(name, description));
  return dir;
}

test('one skills folder per recipe links the bound skills, and hand-made entries survive', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-skills-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const home = join(root, 'graph');
  const library = join(root, 'state', 'capabilities');
  const bound = await skillDir(join(library, 'handoff'), '1.0.0', 'handoff', 'Compact the conversation.');

  const dir = agentSkillsDir('coder', home);
  expect(dir).toBe(join(home, 'agents', 'coder', 'skills'));

  syncAgentSkills({ dir, ownedRoots: [library], links: [{ id: 'handoff', target: bound }] });
  expect((await lstat(join(dir, 'handoff'))).isSymbolicLink()).toBe(true);
  expect(await readlink(join(dir, 'handoff'))).toBe(bound);

  // Hand-made content: a real skill folder and a link to somewhere else entirely.
  await skillDir(dir, 'my-own', 'my-own', 'Hand written by the user.');
  await symlink(join(root, 'elsewhere'), join(dir, 'external'));

  const loaded = agentSkills(dir);
  expect(loaded.skills.map(item => `${item.name}@${item.filePath}`).sort()).toEqual([
    `handoff@${join(dir, 'handoff', 'SKILL.md')}`,
    `my-own@${join(dir, 'my-own', 'SKILL.md')}`,
  ].sort());
  expect(loaded.block).toContain('<available_skills>');
  expect(loaded.block).toContain(`<location>${join(dir, 'handoff', 'SKILL.md')}</location>`);
  expect(loaded.block).toContain('Compact the conversation.');

  // A newly bound version retargets the link instead of adding a second copy.
  const newer = await skillDir(join(library, 'handoff'), '2.0.0', 'handoff', 'Compact the conversation.');
  syncAgentSkills({ dir, ownedRoots: [library], links: [{ id: 'handoff', target: newer }] });
  expect(await readlink(join(dir, 'handoff'))).toBe(newer);

  // Nothing bound any more: only our own link goes away.
  syncAgentSkills({ dir, ownedRoots: [library], links: [] });
  expect(existsSync(join(dir, 'handoff'))).toBe(false);
  expect(existsSync(join(dir, 'my-own', 'SKILL.md'))).toBe(true);
  expect((await lstat(join(dir, 'external'))).isSymbolicLink()).toBe(true);
  expect(agentSkills(dir).skills.map(item => item.name)).toEqual(['my-own']);
});
