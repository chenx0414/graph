import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { applySedimentProposal, parseSedimentProposal, shouldSediment } from '../../src/runtime/sediment.ts';

/**
 * Sedimentation is the one new behaviour in this feature, so its outward rules are pinned here:
 * when a review is worth running, how a reply becomes a proposal, and what may be written where.
 */

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'graph-sediment-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.agents', 'skills'), { recursive: true });
  return root;
}

const GOOD = {
  action: 'create' as const,
  id: 'heartbeat-check',
  description: 'Verify a service is still answering before blaming the code. Use when a long-running process stops responding.',
  body: '# Heartbeat check\n\n1. Confirm the pid is alive.\n',
};

test('the switch, the role, the threshold, a pause and a second look all gate the review', () => {
  const base = { enabled: true, role: 'master', toolCalls: 12, threshold: 10, paused: false, alreadyReviewed: false };

  expect(shouldSediment(base)).toBe(true);
  expect(shouldSediment({ ...base, enabled: false })).toBe(false);
  expect(shouldSediment({ ...base, role: 'worker' })).toBe(false);
  expect(shouldSediment({ ...base, role: null })).toBe(false);
  expect(shouldSediment({ ...base, toolCalls: 3 })).toBe(false);
  expect(shouldSediment({ ...base, paused: true })).toBe(false);
  expect(shouldSediment({ ...base, alreadyReviewed: true })).toBe(false);
});

test('a reply becomes a proposal, and a refusal to sediment becomes nothing', () => {
  const fenced = `\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``;

  expect(parseSedimentProposal(fenced)).toMatchObject({ action: 'create', id: 'heartbeat-check' });
  expect(parseSedimentProposal(`Here you go:\n${JSON.stringify(GOOD)}`)).toMatchObject({ action: 'create' });
  expect(parseSedimentProposal('Nothing to save.')).toBeNull();
  expect(parseSedimentProposal('')).toBeNull();
  expect(parseSedimentProposal('{ not json')).toBeNull();
});

test('an accepted proposal lands as a self-authored skill inside the project', async () => {
  const root = await project();

  const outcome = applySedimentProposal({ projectRoot: root, proposal: GOOD });

  const path = join(root, '.agents', 'skills', 'heartbeat-check', 'SKILL.md');
  const text = await readFile(path, 'utf8');
  expect(text.startsWith('---\nname: heartbeat-check\ncreated-by: graph-agent\ndescription: ')).toBe(true);
  expect(text).toContain('# Heartbeat check');
  expect(outcome.nothing).toBe(false);
  expect(outcome.refused).toEqual([]);
  expect(outcome.written).toEqual([{ id: 'heartbeat-check', path, replaced: false }]);
});

test('what we can write is bounded by shape, not by the model behaving', async () => {
  const root = await project();
  const existing = join(root, '.agents', 'skills', 'theirs', 'SKILL.md');
  await mkdir(join(root, '.agents', 'skills', 'theirs'), { recursive: true });
  await writeFile(existing, '---\nname: theirs\ndescription: Somebody else wrote this. Use when in doubt.\n---\n');

  const escape = applySedimentProposal({ projectRoot: root, proposal: { ...GOOD, id: '../outside' } });
  const noTrigger = applySedimentProposal({ projectRoot: root, proposal: { ...GOOD, description: 'A helper for the thing.' } });
  const noBody = applySedimentProposal({ projectRoot: root, proposal: { ...GOOD, body: '   ' } });
  const foreign = applySedimentProposal({ projectRoot: root, proposal: { ...GOOD, action: 'update', id: 'theirs' } });

  expect(escape.written).toEqual([]);
  expect(escape.refused.join(' ')).toContain('id');
  expect(noTrigger.written).toEqual([]);
  expect(noTrigger.refused.join(' ')).toContain('description');
  expect(noBody.written).toEqual([]);
  expect(foreign.written).toEqual([]);
  expect(foreign.refused.join(' ')).toContain('theirs');
  expect(await readFile(existing, 'utf8')).toContain('Somebody else wrote this');
});

test('nothing to save writes nothing at all', async () => {
  const root = await project();

  const outcome = applySedimentProposal({ projectRoot: root, proposal: { action: 'nothing' } });

  expect(outcome).toEqual({ nothing: true, written: [], refused: [] });
  expect(applySedimentProposal({ projectRoot: root, proposal: null }).nothing).toBe(true);
  expect(await readFile(join(root, '.agents', 'skills', '.keep'), 'utf8').catch(() => null)).toBeNull();
});
