import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { applySedimentProposal, parseSedimentProposal, sedimentCandidates, sedimentReplyShape, shouldSediment } from '../../src/runtime/sediment.ts';

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

test('a markdown body with literal newlines is still read', () => {
  // A model writes a markdown body the way markdown looks, so the newline between two lines arrives
  // as a real newline inside a JSON string and JSON.parse refuses the whole proposal. The reply is
  // otherwise exactly what was asked for, and throwing it away is the difference between a written
  // skill and a silent "nothing".
  const literal = '{"action":"create","id":"newline-body","description":"Use when a body spans several lines","body":"line one\nline two\n\n- a bullet"}';
  const parsed = parseSedimentProposal(literal);
  expect(parsed?.action).toBe('create');
  expect(parsed?.id).toBe('newline-body');
  expect(parsed?.body).toContain('line two');
  // Tabs and carriage returns are the same class of mistake.
  expect(parseSedimentProposal('{"action":"nothing","reason":"a\treason"}')?.action).toBe('nothing');
  // A reply that is genuinely broken stays unreadable instead of being guessed at.
  expect(parseSedimentProposal('{"action":"create","id":')).toBeNull();
  expect(parseSedimentProposal('no json at all')).toBeNull();
});

test('metadata on one line plus a fenced body is read, markdown and all', () => {
  // Asking a model to put a markdown body inside a JSON string asks it to escape markdown, and it
  // will not: real replies arrive with a line break or a quoted command in the middle and the whole
  // proposal is lost. The metadata stays one line; the skill itself travels in a fenced block.
  const reply = [
    '{"action":"create","id":"fenced-body","description":"Use when a skill body needs quotes and lines","reason":"the body is markdown"}',
    '```markdown',
    '## Steps',
    '',
    '1. Run "node --run e2e:console"; it needs chromium.',
    '2. Read the screenshot.',
    '```',
  ].join('\n');
  const parsed = parseSedimentProposal(reply);
  expect(parsed?.action).toBe('create');
  expect(parsed?.id).toBe('fenced-body');
  expect(parsed?.body).toContain('## Steps');
  expect(parsed?.body).toContain('node --run e2e:console');
  // A fence that never closes is not a body, and an empty body is refused by the writer anyway.
  expect(parseSedimentProposal('{"action":"create","id":"x","description":"Use when x"}\n```markdown\nunfinished')?.body).toBeUndefined();
  // The older shape, body inside the JSON, keeps working: a reply is read whatever shape it takes.
  // The body is trimmed on the way in, which is the normalisation the writer applies anyway.
  expect(parseSedimentProposal(JSON.stringify(GOOD))?.body).toBe(GOOD.body.trim());
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

  // "the model said nothing" and "nothing readable came back" both write nothing, and they are not
  // the same fact: the record has to tell them apart, or a silent failure hides behind a decision.
  expect(outcome).toEqual({ nothing: true, written: [], refused: [], proposed: 'nothing' });
  expect(applySedimentProposal({ projectRoot: root, proposal: null })).toEqual({ nothing: true, written: [], refused: [], proposed: null });
  expect(await readFile(join(root, '.agents', 'skills', '.keep'), 'utf8').catch(() => null)).toBeNull();
});

test('the review candidates are the configured model first, then a distinct one to fall back on', () => {
  const entry = (id: string, grade: 'low' | 'medium' | 'high') => ({ id, provider: 'p', grade, api: 'openai-completions' as const, baseUrl: 'https://x.example/v1', contextWindow: 1, maxTokens: 1 });
  const main = entry('main-model', 'high');
  const directory = [main, entry('cheap-model', 'low'), entry('next-model', 'medium')];

  expect(sedimentCandidates(main, directory, 'cheap-model').map(model => model.id)).toEqual(['cheap-model', 'next-model']);
  // With nothing configured, the cheapest distinct model goes first and one alternate follows.
  expect(sedimentCandidates(main, directory, null).map(model => model.id)).toEqual(['cheap-model', 'next-model']);
  // The reviewer is never asked to review the work with the model that did it.
  expect(sedimentCandidates(main, directory, 'main-model').map(model => model.id)).toEqual(['cheap-model', 'next-model']);
  // One candidate is the whole list when nothing else exists.
  expect(sedimentCandidates(main, [main, entry('cheap-model', 'low')], null).map(model => model.id)).toEqual(['cheap-model']);
});

// The live failure this pins down: a 4,363-character reply whose first line was a perfectly good
// metadata object still arrived as `proposed: null`, because the body below it contained braces of its
// own and the parser took the *last* one as the end of the metadata.
test('a body after the metadata line is read without a fence, and a brace inside it cannot hide the metadata', () => {
  const reply = '{"action":"create","id":"no-fence","description":"Use when a one-off call fails"}\n\n## 步骤\n\n1. 先看 `{"a":1}` 这种形状，再决定。\n';
  const parsed = parseSedimentProposal(reply);
  expect(parsed).toMatchObject({ action: 'create', id: 'no-fence' });
  expect(parsed!.body).toContain('## 步骤');
  expect(parsed!.body).toContain('{"a":1}');

  // A fenced body still wins, and the older shape (the proposal with real newlines inside it) still reads.
  expect(parseSedimentProposal('{"action":"create","id":"fenced"}\n```markdown\n# T\n```')!.body).toBe('# T');
  expect(parseSedimentProposal('{"action":"nothing","id":"x",\n  "reason":"仅复述仓库已写着的事实"}')).toMatchObject({ action: 'nothing' });
});

// Without this, "the reply was unreadable" is the whole story and the next occurrence cannot be
// diagnosed: the record has to say what the parser actually saw.
test('what the parser saw is recorded, so a lost decision can be explained', () => {
  expect(sedimentReplyShape('{"action":"nothing"}')).toEqual({
    metadataLine: true, fence: false, chars: 20, tail: '{"action":"nothing"}',
  });
  const long = `${'{"action":"create"}\n\`\`\`markdown\nbody\n\`\`\`\n'}${'x'.repeat(400)}`;
  const shape = sedimentReplyShape(long);
  expect(shape).toMatchObject({ metadataLine: true, fence: true, chars: long.length });
  expect(shape.tail.length).toBeLessThanOrEqual(200);
  expect(shape.tail.endsWith('x'.repeat(20))).toBe(true);
});
