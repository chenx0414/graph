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

const STAGES = ['spec', 'tickets', 'implement', 'review', 'merge'];
const SPEC_ROOT = 'docs/specs';
const MIN_SPEC_CHARS = 200;

function fail(message) {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
// Flags whose value must not be mistaken for a positional argument. The original parser took the
// first non-`--` token as the slug, so `--stage merge` read "merge" as the slug; the merge stage
// takes no slug at all and made that latent bug visible.
const VALUE_FLAGS = new Set(['stage', 'tickets', 'root']);
const positionals = [];
for (let index = 0; index < argv.length; index += 1) {
  const token = argv[index];
  if (token.startsWith('--')) {
    if (VALUE_FLAGS.has(token.slice(2))) index += 1;
    continue;
  }
  positionals.push(token);
}
const slug = positionals[0];
const readOption = name => {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? undefined : argv[index + 1];
};
const flags = new Set(argv.filter(value => value.startsWith('--') && !argv.some((other, i) => i > 0 && argv[i - 1] === value)));
const asJson = flags.has('--json') || argv.includes('--json');
const stage = readOption('stage') ?? 'implement';
const ticketsFile = readOption('tickets');
const root = resolve(readOption('root') ?? process.cwd());

if (!slug && stage !== 'merge') fail('用法：node scripts/matt-flow.mjs <slug> [--stage spec|tickets|implement|review] [--json] [--tickets <file>]');
if (!STAGES.includes(stage)) fail(`--stage 只能是 ${STAGES.join(' | ')}，收到 ${stage}`);
if (!/^[a-z0-9][a-z0-9-]*$/.test(slug) && stage !== 'merge') fail(`slug 只能是小写字母、数字和连字符：${slug}`);

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

/**
 * 合流：前提是**真的有一处冲突**，而不是一个 slug 的产物链。
 *
 * 这条 stage 与其它四条不同：它不查规格与任务（撞车与规格无关），而是查这次合并
 * 到底有没有冲突、工作树是不是干净的。用法：
 *   node scripts/matt-flow.mjs --stage merge [ours-ref] [theirs-ref]
 * 不带 ref 时就看当前工作树（一个已经处于未解决冲突状态的合并）。
 */
function checkMerge() {
  // The merge stage takes no slug, so both positionals are refs.
  const ours = positionals[0];
  const theirs = positionals[1];
  const gitTry = (...args) => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); } catch { return undefined; }
  };
  // merge-tree exits non-zero exactly when it found a conflict, which is the case this stage is
  // looking for - so its output has to survive the failure.
  const gitCapture = (...args) => {
    try {
      return { code: 0, out: execFileSync('git', args, { cwd: root, encoding: 'utf8' }) };
    } catch (error) {
      const failed = error;
      return { code: failed.status ?? 1, out: failed.stdout ?? '' };
    }
  };
  if (gitTry('rev-parse', '--git-dir') === undefined) return record('merge', false, '这不是一个 git 工作副本，没有可合并的东西');

  if (ours && theirs) {
    for (const ref of [ours, theirs]) {
      if (gitTry('rev-parse', '--verify', `${ref}^{commit}`) === undefined) {
        return record('merge', false, `ref 解析不到提交：${ref}`);
      }
    }
    // merge-tree 只算结果、不动工作树；它退出非零恰恰就是找到冲突的时候。
    const probe = gitCapture('merge-tree', '--write-tree', ours, theirs);
    const conflicted = probe.out.trim();
    if (!conflicted) return record('merge', false, `${ours} 与 ${theirs} 无法比较（缺少共同祖先？）`);
    if (!/CONFLICT/.test(conflicted)) {
      return record('merge', false, `${ours} 与 ${theirs} 没有冲突，不需要合流 Agent`);
    }
    const files = [...conflicted.matchAll(/CONFLICT \([^)]*\): (?:Merge conflict in )?(.+)$/gm)].map(match => match[1].trim());
    return record('merge', true, `${files.length || '若干'} 个冲突路径：${[...new Set(files)].slice(0, 10).join(', ') || '(见 merge-tree 输出)'}`);
  }

  // 没有 ref：看当前工作树是不是一个「有冲突的未完成合并」。
  if (gitTry('rev-parse', '-q', '--verify', 'MERGE_HEAD') === undefined) {
    return record('merge', false, '当前没有未完成的合并（缺少 MERGE_HEAD）；要么给两个 ref，要么先开始一次合并');
  }
  const unmerged = gitTry('diff', '--name-only', '--diff-filter=U');
  if (unmerged === undefined) return record('merge', false, '读不到工作树状态');
  const unmergedFiles = unmerged.split('\n').filter(Boolean);
  if (!unmergedFiles.length) return record('merge', false, '这个合并里没有冲突文件；没有要合的东西');
  // Anything else that would move is refused by the judge, including a brand-new untracked file,
  // so the gate names it here instead of letting the agent discover it after doing the work.
  const tracked = (gitTry('diff', '--name-only') ?? '').split('\n').filter(Boolean);
  const untracked = (gitTry('ls-files', '--others', '--exclude-standard') ?? '').split('\n').filter(Boolean);
  const outside = [...new Set([...tracked, ...untracked])].filter(path => !unmergedFiles.includes(path));
  if (outside.length) {
    return record('merge', false, `工作树里有冲突之外的改动（${outside.slice(0, 5).join(', ')}）：合流 Agent 只该动冲突文件，先收拾干净`);
  }
  return record('merge', true, `${unmergedFiles.length} 个冲突文件：${unmergedFiles.slice(0, 10).join(', ')}`);
}

const checks = {
  spec: () => checkSpec(),
  tickets: () => { checkSpec(); checkTickets(); },
  implement: () => { checkSpec(); checkTickets(); checkImplement(); },
  review: () => checkReview(),
  merge: () => checkMerge(),
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
