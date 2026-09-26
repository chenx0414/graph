import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { skillUsage } from '../../src/runtime/skill-usage.ts';
import { TARGET_LIMIT, toolCallTarget } from '../../src/runtime/tool-call-target.ts';

/**
 * Skill usage is derived from tool calls the runtime already recorded, so these cases pin the
 * derivation, not a storage format: which file a call touched, and which skills were never read.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-skill-usage-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const librarian = join(root, 'capabilities');
  const agentSkills = join(root, 'agents', 'main', 'skills');

  for (const [dir, id] of [
    [join(project, '.agents', 'skills'), 'used-skill'],
    [join(project, '.agents', 'skills'), 'idle-skill'],
    [agentSkills, 'agent-skill'],
    [join(librarian, 'skills'), 'library-skill'],
  ] as const) {
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, 'SKILL.md'), `# ${id}\n`);
  }

  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  return { store, project, agentSkills, librarian };
}

function read(base: string, relative: string, at: number) {
  return { instanceId: 'instance-1', tool: 'read', ms: 5, isError: false, target: join(base, relative), at };
}

test('the store migrates to 38 and keeps a target on every tool call', async () => {
  const { store } = await fixture();

  const version = (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  const columns = store.db.prepare('PRAGMA table_info(tool_calls)').all() as { name: string }[];

  expect(version).toBe(38);
  expect(columns.map(column => column.name)).toContain('target');
});

test('a call target is the file it touched, resolved against the workspace', async () => {
  expect(toolCallTarget('read', { path: 'src/a.ts' }, { workspace: '/ws' })).toBe('/ws/src/a.ts');
  expect(toolCallTarget('read', { path: '/abs/a.ts' }, { workspace: '/ws' })).toBe('/abs/a.ts');
  expect(toolCallTarget('write', { file_path: 'notes.md' }, { workspace: '/ws' })).toBe('/ws/notes.md');
  expect(toolCallTarget('bash', { command: 'ls' }, { workspace: '/ws' })).toBeNull();
  expect(toolCallTarget('read', null, { workspace: '/ws' })).toBeNull();
  expect(toolCallTarget('read', { path: `/${'x'.repeat(400)}` }, { workspace: '/ws' })?.length).toBe(TARGET_LIMIT);
});

test('usage counts the calls that touched a skill and marks the rest never read', async () => {
  const { store, project, agentSkills, librarian } = await fixture();
  const now = Date.now();

  store.recordToolCall(read(project, '.agents/skills/used-skill/SKILL.md', now - 1_000));
  store.recordToolCall(read(project, '.agents/skills/used-skill/SKILL.md', now));
  store.recordToolCall(read(agentSkills, 'agent-skill/SKILL.md', now - 5_000));
  // A call with no identifiable target must not be attributed to anything.
  store.recordToolCall({ instanceId: 'instance-1', tool: 'bash', ms: 3, isError: false, at: now });

  const report = skillUsage({ store, projectRoot: project, agentSkillsDir: agentSkills, capabilityRoot: librarian });
  const byId = new Map(report.skills.map(skill => [skill.id, skill]));

  expect(byId.get('used-skill')).toMatchObject({ reads: 2, lastReadAt: now, neverRead: false, source: 'project' });
  expect(byId.get('agent-skill')).toMatchObject({ reads: 1, neverRead: false, source: 'agent' });
  expect(byId.get('idle-skill')).toMatchObject({ reads: 0, lastReadAt: null, neverRead: true });
  expect(byId.get('library-skill')).toMatchObject({ reads: 0, neverRead: true, source: 'library' });
  expect(report.summary).toEqual({ skills: 4, neverRead: 2 });
});

test('a call older than the retention window stops counting as a read', async () => {
  const { store, project } = await fixture();
  const now = Date.now();

  store.recordToolCall(read(project, '.agents/skills/used-skill/SKILL.md', now - 3 * 86_400_000));

  const report = skillUsage({ store, projectRoot: project, keepDays: 1 });
  const used = report.skills.find(skill => skill.id === 'used-skill');

  expect(used).toMatchObject({ reads: 0, neverRead: true });
});
