#! /usr/bin/env node
/**
 * Skill sedimentation, end to end and repeatable.
 *
 * The review makes a model call, so the check injects the reply instead of paying for one: gate,
 * parse and apply run for real, against a real project directory with a real `skills:lint` pass at
 * the end. What it proves is exactly what the acceptance asks — a lesson lands as a self-authored
 * skill that satisfies the contract, a proposal that would leave the project skill folder never gets
 * written, and with the switch off (or too little work done) no review happens at all.
 *
 * Run: node --run e2e:sediment
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  existingSkillSummaries, runSedimentReview, sedimentSettings,
} from '../src/runtime/sediment.ts';

const run = promisify(execFile);
const repo = join(import.meta.dirname, '..');

let failures = 0;
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : `\n       实际=${JSON.stringify(actual)}\n       期望=${JSON.stringify(expected)}`}`);
}

const ROOT = await mkdtemp(join(tmpdir(), 'graph-sediment-e2e-'));
const project = join(ROOT, 'project');
await mkdir(join(project, '.agents', 'skills'), { recursive: true });

/** The review is injected: a stub that counts its calls, so "was a review even attempted" is observable. */
function stub(reply: string) {
  const calls: string[] = [];
  return {
    calls,
    review: async () => { calls.push('called'); return reply; },
  };
}

const GATE = { enabled: true, role: 'master', toolCalls: 12, threshold: 10, paused: false, alreadyReviewed: false };
const PROPOSAL = JSON.stringify({
  action: 'create',
  id: 'console-e2e-authoring',
  description: 'Assert a console page in a real browser before claiming it works. Use when a UI change needs proof rather than a screenshot of the code.',
  body: '# Console E2E authoring\n\n1. Boot a throwaway daemon with a temp state directory.\n2. Drive the real bundle in a browser and assert the page, not the component.\n',
  reason: 'This operation proved a console page in a real browser',
});

console.log(`工程目录 ${project}\n`);

// ① The switch is read tolerantly: absent means off, and a nonsense threshold falls back.
const on = sedimentSettings({ skills: { sedimentation: { enabled: true, afterToolCalls: 5 } } });
check('开关：enabled/阈值被读到', [on.enabled, on.afterToolCalls], [true, 5]);
check('开关：缺省就是关闭', sedimentSettings({}).enabled, false);
check('开关：坏阈值回落', sedimentSettings({ skills: { sedimentation: { enabled: true, afterToolCalls: 0 } } }).afterToolCalls, 10);

// ② Switch off: no review at all, so no model call can happen.
const off = stub(PROPOSAL);
check('关闭时不发评审', (await runSedimentReview({ gate: GATE, settings: sedimentSettings({}), projectRoot: project, payload: {}, review: off.review })).reviewed, false);
check('关闭时没调过模型', off.calls.length, 0);

// ③ Too little work: still no review.
const thin = stub(PROPOSAL);
check('工具调用不足时不发评审', (await runSedimentReview({ gate: { ...GATE, toolCalls: 3 }, settings: on, projectRoot: project, payload: {}, review: thin.review })).reviewed, false);
check('工具调用不足时没调过模型', thin.calls.length, 0);

// ④ A lesson lands as a self-authored skill that satisfies the contract.
const happy = stub(PROPOSAL);
const applied = await runSedimentReview({ gate: GATE, settings: on, projectRoot: project, payload: { existingSkills: existingSkillSummaries(project) }, review: happy.review });
const written = join(project, '.agents', 'skills', 'console-e2e-authoring', 'SKILL.md');
const text = existsSync(written) ? await readFile(written, 'utf8') : '';
check('评审真的发生', [applied.reviewed, happy.calls.length], [true, 1]);
check('技能落盘', existsSync(written), true);
check('落盘带自著声明', text.includes('created-by: graph-agent'), true);
check('产物列表回填', applied.outcome.written.map(item => item.id), ['console-e2e-authoring']);
check('既有技能清单能看到它', existingSkillSummaries(project).map(item => item.id), ['console-e2e-authoring']);
const lint = await run('node', [join(repo, 'scripts', 'skills-lint.mjs'), '--root', project, '--strict'], { cwd: repo })
  .then(result => result.stdout, cause => String((cause as { stdout?: string }).stdout ?? cause));
check('落盘产物过 skills:lint --strict', lint.includes('no warnings'), true);

// ⑤ Shape decides what may be written, not the model behaving.
const escape = stub(JSON.stringify({ action: 'create', id: '../outside', description: 'Use when escaping.', body: '# x' }));
const escaped = await runSedimentReview({ gate: GATE, settings: on, projectRoot: project, payload: {}, review: escape.review });
check('id 逃逸被拒', escaped.outcome.written.length, 0);
check('逃逸后项目外无文件', existsSync(join(ROOT, 'outside', 'SKILL.md')), false);

const vague = stub(JSON.stringify({ action: 'create', id: 'vague-helper', description: 'A helper for the thing.', body: '# x' }));
check('描述无触发条件被拒', (await runSedimentReview({ gate: GATE, settings: on, projectRoot: project, payload: {}, review: vague.review })).outcome.written.length, 0);
check('被拒的没留目录', existsSync(join(project, '.agents', 'skills', 'vague-helper')), false);

await mkdir(join(project, '.agents', 'skills', 'theirs'), { recursive: true });
await writeFile(join(project, '.agents', 'skills', 'theirs', 'SKILL.md'), '---\nname: theirs\ndescription: Somebody else wrote this. Use when in doubt.\n---\n');
const foreign = stub(JSON.stringify({ action: 'update', id: 'theirs', description: 'Use when in doubt.', body: '# theirs, rewritten' }));
check('不改别人写的技能', (await runSedimentReview({ gate: GATE, settings: on, projectRoot: project, payload: {}, review: foreign.review })).outcome.written.length, 0);
check('别人的技能未被改写', (await readFile(join(project, '.agents', 'skills', 'theirs', 'SKILL.md'), 'utf8')).includes('Somebody else wrote this'), true);

// ⑥ "Nothing to save" is a real answer and writes nothing.
const nothing = stub('Nothing to save.');
const quiet = await runSedimentReview({ gate: GATE, settings: on, projectRoot: project, payload: {}, review: nothing.review });
check('Nothing to save → 什么都没写', [quiet.reviewed, quiet.outcome.nothing, quiet.outcome.written.length], [true, true, 0]);
check('目录里只有那两个技能目录', (await readdir(join(project, '.agents', 'skills'))).filter(name => !name.startsWith('.')).sort(), ['console-e2e-authoring', 'theirs']);

console.log(failures ? `\n技能沉淀 E2E 失败：${failures} 处（产物在上面的临时目录里）` : '\n技能沉淀 E2E 通过');
process.exit(failures ? 1 : 0);
