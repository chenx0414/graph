#!/usr/bin/env node
// -*- coding: utf-8 -*-
/**
 * 文档驱动流程的机械闸门：规格 → 任务 → 实现 → 审查。
 *
 * 一件事只做一件事：**检查前置产物是否真的存在**，而不是检查它们写得好不好。
 * 任何一环缺失或不满足契约，就以非零退出并说清缺什么——它绝不「大致通过」，
 * 也绝不自己编一份产物。同一份实现被三处引用：main 派发前跑、两个 subagent 身份
 * 的第一步跑、以及任务图里的 `graph.command` 检查节点跑。
 *
 * 用法：
 *   node scripts/matt-flow.mjs <slug> --stage spec|tickets|implement|review
 *   node scripts/matt-flow.mjs <slug>                # 检查到 implement（不含审查）
 *   node scripts/matt-flow.mjs <slug> --json         # 机器可读
 *
 * 任务来自 GitHub Issues；离线/测试时用 `--tickets <json 文件>` 喂一份
 * `gh issue list --json number,title,body,labels` 的输出（同一个解析路径）。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const STAGES = ['spec', 'tickets', 'implement', 'review'];
const SPEC_ROOT = 'docs/specs';
const MIN_SPEC_CHARS = 200;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
const slug = argv.find(value => !value.startsWith('--'));
const readOption = name => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const flags = new Set(argv.filter(value => value.startsWith('--') && !argv.some((other, i) => i > 0 && argv[i - 1] === value)));
const asJson = flags.has('--json') || argv.includes('--json');
const stage = readOption('stage') ?? 'implement';
const ticketsFile = readOption('tickets');
const root = resolve(readOption('root') ?? process.cwd());

if (!slug) fail('用法：node scripts/matt-flow.mjs <slug> [--stage spec|tickets|implement|review] [--json] [--tickets <file>]');
if (!STAGES.includes(stage)) fail(`--stage 只能是 ${STAGES.join(' | ')}，收到 ${stage}`);
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) fail(`slug 只能是小写字母、数字和连字符：${slug}`);

const results = [];
const record = (name, ok, detail) => {
  const item = { name, ok, detail };
  results.push(item);
  return item;
};

function specPath() {
  return join(root, SPEC_ROOT, `${slug}.md`);
}

function checkSpec() {
  const path = specPath();
  if (!existsSync(path)) return record('spec', false, `缺少规格文件 ${SPEC_ROOT}/${slug}.md`);
  const text = readFileSync(path, 'utf8');
  if (text.trim().length < MIN_SPEC_CHARS) return record('spec', false, `规格只有 ${text.trim().length} 字符（至少 ${MIN_SPEC_CHARS}）：${SPEC_ROOT}/${slug}.md`);
  if (!/^#\s+\S/m.test(text)) return record('spec', false, `规格没有标题行：${SPEC_ROOT}/${slug}.md`);
  if (!/^##\s+\S/m.test(text)) return record('spec', false, `规格没有小节（至少一个 ## ）：${SPEC_ROOT}/${slug}.md`);
  return record('spec', true, `${SPEC_ROOT}/${slug}.md（${text.length} 字符）`);
}

/** 任务：来自 `gh issue list --json number,title,body,labels`，每一条都要能指回这份规格。 */
function readTickets() {
  if (ticketsFile) {
    if (!existsSync(ticketsFile)) fail(`--tickets 指向的文件不存在：${ticketsFile}`);
    return JSON.parse(readFileSync(ticketsFile, 'utf8'));
  }
  try {
    const out = execFileSync('gh', ['issue', 'list', '--state', 'all', '--limit', '200', '--json', 'number,title,body,labels'], { cwd: root, encoding: 'utf8' });
    return JSON.parse(out || '[]');
  } catch (error) {
    fail(`读不到任务列表（gh 不可用或未登录？）：${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkTickets() {
  const spec = `${SPEC_ROOT}/${slug}.md`;
  const issues = readTickets();
  if (!Array.isArray(issues)) fail('任务列表不是数组：期望 gh issue list --json 的输出');
  const mine = issues.filter(issue => {
    const haystack = `${issue.title ?? ''}\n${issue.body ?? ''}`;
    return haystack.includes(slug) || haystack.includes(spec);
  });
  if (!mine.length) return record('tickets', false, `没有任何 issue 提到 ${slug} 或 ${spec}（共看了 ${issues.length} 条）`);
  const unlinked = mine.filter(issue => !`${issue.body ?? ''}`.includes(spec) && !`${issue.body ?? ''}`.includes(slug));
  if (unlinked.length) return record('tickets', false, `issue ${unlinked.map(issue => `#${issue.number}`).join(', ')} 没有指回规格`);
  const labelled = mine.filter(issue => (issue.labels ?? []).some(label => ['ready-for-agent', 'ready-for-human', 'needs-triage', 'needs-info', 'wontfix'].includes(label.name ?? label)));
  if (!labelled.length) return record('tickets', false, `issue ${mine.map(issue => `#${issue.number}`).join(', ')} 都没有分诊标签（见 docs/agents/triage-labels.md）`);
  return record('tickets', true, `${mine.length} 条：#${mine.map(issue => issue.number).join(', #')}`);
}

function checkImplement() {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  let tracked;
  try {
    tracked = git('status', '--porcelain').trim().length > 0 || git('log', '--oneline', '-1').trim().length > 0;
  } catch {
    return record('implement', false, '这不是一个 git 工作副本，无法判断实现是否存在');
  }
  if (!tracked) return record('implement', false, '工作副本里没有任何提交或改动');
  const issues = readTickets().filter(issue => `${issue.title ?? ''}\n${issue.body ?? ''}`.includes(slug));
  if (!issues.length) return record('implement', false, '没有提到该 slug 的任务，无法把实现对上任务');
  const numbers = issues.map(issue => `#${issue.number}`);
  const haystack = `${git('log', '--oneline', '-200')}\n${git('diff', '--stat', 'HEAD')}`;
  const cited = numbers.filter(number => haystack.includes(number));
  if (!cited.length) return record('implement', false, `提交与改动里都没有引用任务号（${numbers.join(', ')}）：实现与任务对不上`);
  return record('implement', true, `引用到 ${cited.join(', ')}`);
}

function checkReview() {
  const spec = checkSpec();
  const tickets = checkTickets();
  const implement = checkImplement();
  const upstream = [spec, tickets, implement].every(item => item.ok);
  if (!upstream) return record('review', false, '审查的前提未满足：规格、任务、实现三者必须齐备');
  return record('review', true, `可审查：${SPEC_ROOT}/${slug}.md + ${tickets.detail}`);
}

const checks = {
  spec: () => checkSpec(),
  tickets: () => { checkSpec(); checkTickets(); },
  implement: () => { checkSpec(); checkTickets(); checkImplement(); },
  review: () => checkReview(),
};
checks[stage]();

const failed = results.filter(item => !item.ok);
if (asJson) {
  console.log(JSON.stringify({ slug, stage, ok: failed.length === 0, results }, null, 2));
} else {
  for (const item of results) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}: ${item.detail}`);
  console.log(failed.length ? `\n${failed.length} 项未满足（stage=${stage}，slug=${slug}）：先补齐再往下走。` : `\n全部满足（stage=${stage}，slug=${slug}）。`);
}
process.exit(failed.length ? 1 : 0);
