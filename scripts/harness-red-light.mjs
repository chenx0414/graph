#!/usr/bin/env node
/**
 * Prove that each production change is the reason its test passes.
 *
 * A test that passes tells you nothing about whether the code it covers is
 * what makes it pass. The only proof is to take the change away and watch the
 * test go red, then put it back and watch the test go green.
 *
 * This script does exactly that, one change at a time:
 *
 *   1. it edits the production file to take the change away,
 *   2. it rebuilds the Go backend, because the E2E suite drives the real binary,
 *   3. it runs the E2E that covers the change and requires it to fail,
 *   4. it puts the file back and rebuilds.
 *
 * At the end it runs every covered E2E again with everything restored and
 * requires them to pass. A run that ends with a red suite has left the tree
 * broken, and the script says so.
 *
 * The tree must be clean before the script starts: it restores files with
 * `git checkout`, and that would throw away uncommitted work.
 *
 * Usage:
 *   node scripts/harness-red-light.mjs [--out <file>]
 *
 * Options:
 *   --out <file>   write the transcript of the run to that file
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = process.cwd();
const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : null;

const CHECKS = [
  {
    name: '助手回合如实回放',
    subject: 'Replay the assistant turn the model wrote',
    proves: '模型写下的 reasoning 回到下一轮请求里',
    e2e: 'tests/e2e/provider-assistant-replay.test.ts',
    edits: [{
      file: 'backend/internal/graph/runtime_controlled_assistant_replay.go',
      from: `	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		blocks = append(blocks, block)
	}`,
      to: `	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if block["type"] == "thinking" {
			continue
		}
		blocks = append(blocks, block)
	}`,
    }],
  },
  {
    name: 'Anthropic 缓存断点',
    subject: 'Mark the cacheable prefix on the Anthropic transport',
    proves: '系统提示、工具声明、对话三处断点在请求里',
    e2e: 'tests/e2e/provider-assistant-replay.test.ts',
    edits: [{
      file: 'backend/internal/graph/runtime_controlled_anthropic_cache.go',
      from: `func controlledAnthropicSystem(system string) []any {
	return []any{map[string]any{
		"type": "text", "text": system, "cache_control": controlledAnthropicCacheControl,
	}}
}`,
      to: `func controlledAnthropicSystem(system string) []any {
	return []any{map[string]any{"type": "text", "text": system}}
}`,
    }, {
      file: 'backend/internal/graph/runtime_controlled_anthropic_cache.go',
      from: `func controlledAnthropicCachedTools(tools []any) []any {
	if len(tools) == 0 {
		return tools
	}
	out := make([]any, 0, len(tools))
	out = append(out, tools[:len(tools)-1]...)
	last, ok := tools[len(tools)-1].(map[string]any)
	if !ok {
		return append(out, last)
	}
	marked := map[string]any{}
	for key, value := range last {
		marked[key] = value
	}
	marked["cache_control"] = controlledAnthropicCacheControl
	return append(out, marked)
}`,
      to: `func controlledAnthropicCachedTools(tools []any) []any {
	return tools
}`,
    }, {
      file: 'backend/internal/graph/runtime_controlled_anthropic_cache.go',
      from: `func controlledAnthropicCachedMessages(messages []any) []any {
	for index := len(messages) - 1; index >= 0; index-- {
		message, ok := messages[index].(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		if role != "user" && role != "assistant" {
			continue
		}
		if controlledAnthropicMarkBreakpoint(message) {
			messages[index] = message
			return messages
		}
	}
	return messages
}`,
      to: `func controlledAnthropicCachedMessages(messages []any) []any {
	return messages
}`,
    }],
  },
  {
    name: '压缩上限',
    subject: 'Let the environment name how far the context may grow',
    proves: '环境变量命名的上限让会话提前压缩',
    e2e: 'tests/e2e/compaction-context-ceiling.test.ts',
    edits: [{
      file: 'backend/internal/graph/runtime_compaction.go',
      from: `	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0
	}
	return value
}`,
      to: `	value, err := strconv.Atoi(raw)
	if err != nil || value < 1 {
		return 0
	}
	return 0
}`,
    }],
  },
  {
    name: '摘要输出预算',
    subject: 'Give the summarizer the room the handoff needs',
    proves: '摘要请求带的是它自己的额度，不是模型的整个上限',
    e2e: 'tests/e2e/compaction-context-ceiling.test.ts',
    edits: [{
      file: 'backend/internal/graph/runtime_controlled_openai.go',
      from: `	limit := int64(0)
	if requested, ok := controlledSafeCount(stream.options[pigkernel.MaxTokensOption]); ok && requested > 0 {
		limit = requested
	} else if tokens, ok := controlledSafeCount(record["maxTokens"]); ok && tokens > 0 {
		limit = tokens
	}`,
      to: `	limit := int64(0)
	if tokens, ok := controlledSafeCount(record["maxTokens"]); ok && tokens > 0 {
		limit = tokens
	} else if requested, ok := controlledSafeCount(stream.options[pigkernel.MaxTokensOption]); ok && requested > 0 {
		limit = requested
	}`,
    }],
  },
  {
    name: '任务说明包复用',
    subject: 'Let the session keep the task setup it already read',
    proves: '开启开关后第二轮不再重发任务说明',
    e2e: 'tests/e2e/task-setup-reuse.test.ts',
    edits: [{
      file: 'backend/internal/graph/runtime_task_setup.go',
      from: `func (ledger *TaskSetupLedger) Sent(instanceId string, sessionId string, setup string) bool {
	if ledger == nil || instanceId == "" || sessionId == "" || setup == "" {
		return false
	}
	ledger.mutex.Lock()
	defer ledger.mutex.Unlock()
	entry, known := ledger.entries[instanceId]
	if !known || entry.sessionId != sessionId {
		return false
	}
	return entry.digest == taskSetupDigest(setup)
}`,
      to: `func (ledger *TaskSetupLedger) Sent(instanceId string, sessionId string, setup string) bool {
	return false
}`,
    }],
  },
  {
    name: '来源 × 计费类型的交叉',
    subject: 'Price the whole tree and show the prefix every request carried',
    proves: '每一笔花费按来源和计费类型两个维度分开',
    e2e: 'tests/e2e/harness-cost.test.ts',
    edits: [{
      file: 'scripts/harness-cost.mjs',
      from: `      costByPurposeAndBillingType: purposeCosts,`,
      to: `      costByPurposeAndBillingType: {},`,
    }],
  },
  {
    name: '工具结果落盘',
    subject: 'Give the tool result the handle the model needs to read the rest',
    proves: '大结果落盘后模型拿到的是句柄而不是被切断的原文',
    e2e: 'tests/e2e/tool-result-spill.test.ts',
    // The seam has an off switch, so taking it away needs no edit at all.
    env: { GRAPH_TOOL_RESULT_SEAM: '0' },
  },
];

/**
 * The commit that carries a change, by its subject.
 *
 * A rebase rewrites every hash, so the subject is the stable name and the
 * hash is looked up when the script runs.
 */
function commitFor(subject) {
  const base = run('git', ['merge-base', 'main', 'HEAD']).stdout.trim();
  const found = run('git', ['log', '--format=%H%x00%s', `${base}..HEAD`])
    .stdout.split('\n')
    .map(line => line.split('\0'))
    .find(([, text]) => text === subject);
  if (!found) throw new Error(`No commit on the branch is titled: ${subject}`);
  return found[0].slice(0, 8);
}

const lines = [];
function say(text = '') {
  lines.push(text);
  console.log(text);
}

function run(command, args, options = {}) {
  try {
    const stdout = execFileSync(command, args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...options });
    return { code: 0, stdout };
  } catch (error) {
    const failure = error ?? {};
    return { code: failure.status ?? 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

function dirtyFiles() {
  const status = run('git', ['status', '--porcelain=v1', '--untracked-files=no']).stdout.trim();
  return status ? status.split('\n') : [];
}

function buildBackend() {
  const result = run(process.execPath, ['scripts/build-backend.mjs']);
  if (result.code !== 0) {
    console.error(result.stderr);
    throw new Error('The Go backend could not be built.');
  }
}

/** Run one E2E file and report which of its tests failed. */
function runE2E(files, label, env) {
  const list = Array.isArray(files) ? files : [files];
  const report = join(mkdtempSync(join(tmpdir(), 'graph-red-light-')), 'report.json');
  const result = run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...list,
    '--reporter=default', '--reporter=json', `--outputFile=${report}`],
    { env: { ...process.env, ...env } });
  let failed = [];
  let total = 0;
  if (existsSync(report)) {
    const parsed = JSON.parse(readFileSync(report, 'utf8'));
    total = parsed.numTotalTests ?? 0;
    for (const suite of parsed.testResults ?? []) {
      for (const assertion of suite.assertionResults ?? []) {
        if (assertion.status === 'failed') failed.push(assertion.fullName || assertion.title);
      }
    }
  }
  return { code: result.code, failed, total, stdout: result.stdout, label };
}

const dirty = dirtyFiles();
if (dirty.length) {
  console.error('The tree has uncommitted changes, and this script restores files with git checkout:');
  for (const file of dirty) console.error(`- ${file}`);
  console.error('\nCommit or stash them first.');
  process.exit(1);
}

say('# 红灯验证：撤掉生产改动，E2E 必须红');
say('');
say(`分支：${run('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim()}`);
say(`时间：${new Date().toISOString()}`);
say('');
say('| 改动 | 撤掉的是什么 | E2E | 结果 |');
say('| --- | --- | --- | --- |');

let failures = 0;
for (const check of CHECKS) {
  const touched = new Set();
  try {
    for (const edit of check.edits ?? []) {
      const path = join(REPO, edit.file);
      const text = readFileSync(path, 'utf8');
      const occurrences = text.split(edit.from).length - 1;
      if (occurrences !== 1) {
        throw new Error(`${edit.file}: the text to replace occurs ${occurrences} times, expected once`);
      }
      writeFileSync(path, text.replace(edit.from, edit.to));
      touched.add(edit.file);
    }
    // Only a Go change needs the backend rebuilt: the E2E drives the real
    // binary, and a script the daemon never loads does not.
    if (check.edits?.some(edit => edit.file.endsWith('.go'))) buildBackend();
    const run1 = runE2E(check.e2e, check.name, check.env);
    const red = run1.code !== 0 && run1.failed.length > 0;
    if (!red) failures += 1;
    const detail = red
      ? `**红**（${run1.failed.length} 项失败：${run1.failed.slice(0, 2).join('；')}${run1.failed.length > 2 ? ' …' : ''}）`
      : `**没红**（退出码 ${run1.code}，失败 ${run1.failed.length} 项）`;
    say(`| \`${commitFor(check.subject)}\` ${check.name} | ${check.proves} | \`${check.e2e}\` | ${detail} |`);
  } catch (error) {
    failures += 1;
    say(`| \`${commitFor(check.subject)}\` ${check.name} | ${check.proves} | \`${check.e2e}\` | **出错**：${error?.message ?? error} |`);
  } finally {
    for (const file of touched) run('git', ['checkout', '--', file]);
    if (check.edits?.some(edit => edit.file.endsWith('.go'))) buildBackend();
  }
}

say('');
say('## 还原之后');
const all = [...new Set(CHECKS.map(check => check.e2e))];
const final = runE2E(all, 'restored');
say('');
say(`还原后重跑 ${all.length} 个 E2E 文件：${final.code === 0 ? `**绿**（${final.total} 项）` : `**红**（退出码 ${final.code}，失败 ${final.failed.length} 项：${final.failed.join('；')}）`}`);
if (final.code !== 0) failures += 1;
say('');
say(failures === 0
  ? '**结论：每一处生产改动都是它那条 E2E 变红的原因，还原后全部变绿。**'
  : `**结论：有 ${failures} 处没有按预期变红或还原后仍是红的。**`);

if (outPath) {
  writeFileSync(outPath, lines.join('\n') + '\n');
  console.error(`\n[red-light] transcript written to ${outPath}`);
}
process.exit(failures === 0 ? 0 : 1);
