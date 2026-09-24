import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { CapabilityLibrary } from '../../src/catalog/capability-library.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

test('a skill placed in an Agent folder appears in the library with its native fact', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-skills-library-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const skillsDir = join(root, 'graph', 'agents', 'main', 'skills');

  // Hand-placed by the user: one usable skill and one the native loader will skip.
  await mkdir(join(skillsDir, 'my-notes'), { recursive: true });
  await writeFile(join(skillsDir, 'my-notes', 'SKILL.md'), '---\nname: my-notes\ndescription: Take notes.\n---\n\n# Notes\n');
  await mkdir(join(skillsDir, 'broken'), { recursive: true });
  await writeFile(join(skillsDir, 'broken', 'SKILL.md'), '# Broken\n');

  // A bound skill is mirrored in as a symlink and is already listed from the library.
  const bound = join(capabilityRoot, 'handoff', '1.0.0');
  await mkdir(bound, { recursive: true });
  await writeFile(join(bound, 'SKILL.md'), '---\nname: handoff\ndescription: Compact the conversation.\ndisable-model-invocation: true\n---\n');
  await writeFile(join(bound, 'capability.json'), JSON.stringify({ id: 'handoff', kind: 'skill', version: '1.0.0', name: 'Handoff' }));
  await symlink(bound, join(skillsDir, 'handoff'));

  const library = new CapabilityLibrary({ capabilityRoot });
  await library.refreshCapabilities();
  const byId = new Map(library.capabilities().map(item => [item.id, item]));
  expect([...byId.keys()].sort()).toEqual(['broken', 'handoff', 'my-notes']);
  expect(byId.get('my-notes')).toMatchObject({
    kind: 'skill', version: 'local', status: 'available', owner: 'main', name: 'my-notes',
    description: 'Take notes.',
  });
  // The native loader skips a SKILL.md without frontmatter: say so instead of hiding it.
  expect(byId.get('broken')).toMatchObject({ status: 'invalid', owner: 'main', version: 'local' });
  expect(byId.get('broken')?.error).toContain('frontmatter');
  // A bound skill keeps its own record, with the reason it stays out of the prompt.
  expect(byId.get('handoff')).toMatchObject({ version: '1.0.0', status: 'available' });
  expect(byId.get('handoff')?.note).toContain('disable-model-invocation');
});

test('skills in a project .pi or .agents folder appear with their project owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-skills-project-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const project = join(root, 'checkout');
  await mkdir(join(project, '.agents', 'skills', 'repo-skill'), { recursive: true });
  await writeFile(join(project, '.agents', 'skills', 'repo-skill', 'SKILL.md'), '---\nname: repo-skill\ndescription: Ships with the repo.\n---\n');
  await mkdir(join(project, '.pi', 'skills', 'pi-skill'), { recursive: true });
  await writeFile(join(project, '.pi', 'skills', 'pi-skill', 'SKILL.md'), '---\nname: pi-skill\ndescription: Pi project skill.\n---\n');

  const library = new CapabilityLibrary({ capabilityRoot, projects: () => [{ id: 'demo', root: project }] });
  await library.refreshCapabilities();
  const byId = new Map(library.capabilities().map(item => [item.id, item]));
  expect(byId.get('repo-skill')).toMatchObject({
    kind: 'skill', version: 'local', status: 'available', owner: '项目 demo（.agents）', name: 'repo-skill',
  });
  expect(byId.get('pi-skill')).toMatchObject({ kind: 'skill', version: 'local', owner: '项目 demo（.pi）' });
});
