import { isEnvironmentFailure } from '../core/environment-failure.ts';
import { awaitRsiReload, confirmRsiContinuation } from '../core/rsi-continuation.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { appendMessage, conversationForTask, markOperationReplied, RSI_RELOAD_RECEIPT } from '../core/conversation.ts';
import type { TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { checkedOutBranch, detectRepo, git, gitRaw, revParse } from '../git/git.ts';

/**
 * Why a `from` value cannot be used as a revision, or undefined when it can.
 *
 * One rule with two callers - the model-facing shape hint and the change parser - so the two cannot
 * drift: a path smuggled into the revision, whitespace, a leading dash (an option, not a revision) and
 * an empty value are refused in the same words, in the same place.
 */
export function revisionRefusal(from: unknown): string | undefined {
  const rev = typeof from === 'string' ? from.trim() : '';
  if (!rev) return 'must name the revision to copy the file from (for a mirror: the commit that holds the finished file)';
  if (rev.length > 200 || rev.includes(':') || rev.startsWith('-') || /\s/.test(rev)) {
    return `must be a revision only - "${rev}" carries something else (a path belongs in "path", not in the revision)`;
  }
  return undefined;
}
import { graphApplicationRoot } from './graph-root.ts';
import { RUNTIME_NODE_ENV } from './workspace-command.ts';
import { developerPath } from './developer-path.ts';

const execFileAsync = promisify(execFile);
// Only the report is bounded: it is what gets persisted in the conversation and
// shown in the UI. File contents are not capped — the change set already travels
// through a single model tool call, and a large file is a legitimate change.
const MAX_REPORT_DIFF = 40_000;
const CHECK_TIMEOUT_MS = 15 * 60_000;
const BUILD_TIMEOUT_MS = 20 * 60_000;

export interface RsiCommand {
  command: 'node';
  args: string[];
}

export type RsiFileChange =
  | { path: string; action: 'write'; content: string }
  | { path: string; action: 'replace'; edits: { oldText: string; newText: string }[] }
  | { path: string; action: 'copy'; from: string }
  | { path: string; action: 'delete' };

export interface RsiChangeInput {
  title: string;
  problem: string;
  evidence?: string;
  diagnosis?: string;
  impact?: string;
  risk?: string;
  changes: RsiFileChange[];
  checks?: RsiCommand[];
  activate?: boolean;
  /** Reload even while other operations are still running; may interrupt them. */
  force?: boolean;
}

export interface RsiValidationResult {
  command: string;
  status: 'passed' | 'failed';
  output: string;
}

export interface RsiReceipt {
  id: string;
  status: 'applied' | 'checks_failed' | 'rolled_back' | 'unavailable';
  title: string;
  root: string | null;
  branch: string | null;
  commit: string | null;
  files: string[];
  validation: RsiValidationResult[];
  restartRequired: boolean;
  activation?: { state: 'saved' | 'pending_reload' | 'active' | 'checked_only'; confirmedAt?: number; generation?: number };
  force?: boolean;
  /** Files left uncommitted by this or an earlier failed attempt, still fixable. */
  pendingFiles?: string[];
  error?: string;
  diff?: string;
  report: string;
  /** Full check output for this attempt, written outside the receipt the conversation stores. */
  outputPath?: string;
}

/**
 * What a turn that changed the harness itself did, in the reviewer's terms.
 *
 * An activation turn has no assistant reply: `apply_rsi_change(activate:true)` ends the turn and the
 * model is never asked again. So the change is the material — its title, the report that says why it
 * was needed, the files it moved and what the gate said — never the reload receipt, which only names a
 * request id. The receipt crosses the tool boundary as JSON, so every field is read defensively.
 */
export function rsiChangeMaterial(receipt: Record<string, unknown>, reply: string): string {
  const text = (value: unknown) => typeof value === 'string' ? value : '';
  const files = Array.isArray(receipt['files']) ? receipt['files'].filter((item): item is string => typeof item === 'string') : [];
  const checks = Array.isArray(receipt['validation'])
    ? receipt['validation'].flatMap(row => row && typeof row === 'object'
      ? [`${text((row as Record<string, unknown>)['command'])}: ${text((row as Record<string, unknown>)['status'])}`]
      : [])
    : [];
  return [
    reply.trim(),
    text(receipt['title']) ? `RSI 变更：${text(receipt['title'])}` : '',
    files.length ? `文件：${files.join(', ')}` : '',
    checks.length ? `验证：${checks.join('；')}` : '',
    text(receipt['report']),
    text(receipt['diff']) ? `diff：\n\`\`\`diff\n${text(receipt['diff']).slice(0, 6_000)}\n\`\`\`` : '',
  ].filter(part => part.trim().length > 0).join('\n\n');
}

export interface RsiStatus {
  available: boolean;
  root: string | null;
  branch: string | null;
  /** Why RSI is unavailable, when it is. */
  reason?: string;
  pendingRestart: {
    id: string;
    root: string;
    branch: string | null;
    commit: string | null;
    requestedAt: number;
    generation?: number;
    force?: boolean;
  } | null;
  activeOperations: number;
  /**
   * Where this repository stands against the branches it has already published.
   *
   * The comparison uses the remote-tracking refs known locally - no fetch happens here - so it can
   * overstate what is unpublished and never hides local work. A branch with no published copy at all
   * is counted, not listed: this checkout holds dozens of task branches that were never meant to be
   * pushed, and a wall of their names would bury the one branch that matters.
   */
  sync: {
    unpublished: { branch: string; upstream: string; ahead: number; behind: number }[];
    /**
     * Self-improvement work branches, which have no publisher by design.
     *
     * The application line is what gets pushed; the `rsi/*` branch a change is committed to is a local
     * working line. Kept apart from `unpublished` because a standing, always-true entry buries the one
     * branch a reader has to act on - which is exactly what a single list produced, every report.
     */
    expected: { branch: string; upstream: string; ahead: number; behind: number }[];
    localOnly: number;
    /** One line a reader can act on without reading the list. */
    note: string;
  } | null;
  /** In-flight operations that keep a normal reload waiting. */
  operations: {
    id: string;
    taskId: string;
    nodeId: string;
    state: string;
    request: string;
    conversationId: string | null;
    archived: boolean;
  }[];
  /** False when the operation ledger could not be read, so a reload must wait. */
  operationsKnown: boolean;
  canRestart: boolean;
  lastActivation: { id: string; commit: string | null; confirmedAt: number; generation: number } | null;
}

interface RsiServiceOptions {
  root?: string;
  stateDir: string;
  validate?: (input: { root: string; checks: RsiCommand[]; activate: boolean; needsBuild?: boolean }) => Promise<RsiValidationResult[]>;
}

interface RsiApplyContext {
  operationId?: string;
  store: TaskStore;
  taskId: string;
  conversationId?: string;
}

function writeAtomic(path: string, content: string) {
  return (async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const pending = `${path}.${process.pid}.${randomUUID()}.pending`;
    await writeFile(pending, content, { mode: 0o600 });
    await rename(pending, path);
  })();
}

function commandOutput(stdout: string | Buffer, stderr: string | Buffer) {
  return [String(stdout), String(stderr)].filter(Boolean).join('\n').trim().slice(-40_000);
}

const ANSI_PATTERN = /\u001b\[[0-9;]*m/g;

/** Lines a test runner prints for the case that failed. */
const FAILURE_LINE = /(^|\s)FAIL |Failed Tests|AssertionError|Matcher did not succeed|Error: |❯ /;

/** A failed check keeps only the last 40,000 characters of its output, and
 * concurrent test workers interleave their reporter lines, so the line that
 * names the failing case can fall outside that window. The report carries this
 * bounded digest so a failure is always explainable without guessing. */
export function failureDigest(validation: RsiValidationResult[], limit = 3_000, maxLines = 30) {
  const lines: string[] = [];
  let used = 0;
  for (const item of validation) {
    if (item.status !== 'failed') continue;
    const found = String(item.output ?? '')
      .replace(ANSI_PATTERN, '')
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && FAILURE_LINE.test(line));
    if (!found.length) continue;
    lines.push(`  - ${item.command}:`);
    for (const line of found) {
      if (lines.length > maxLines || used + line.length > limit) break;
      used += line.length;
      lines.push(`    ${line}`);
    }
  }
  return lines.length ? ['- 失败摘要：', ...lines] : [];
}

export { developerPath };

/** Command line and environment for one check. Checks run outside the sandbox in
 * the user's own checkout, so they keep the inherited environment - except
 * `DYLD_*`: an unrelated installer can point those at its own copies of system
 * libraries, and a node binary started that way dies before its own code runs.
 * A packaged app ships a real node runtime (`GRAPH_APP_NODE`) and validates the
 * checkout with it; otherwise the developer's own `node` runs the gate, exactly
 * as it would from their shell. The inherited `PATH` keeps its order and gains
 * the developer's own toolchain locations, so the gate is the same one the
 * developer would run from a terminal. */
export function validationCommand(
  command: RsiCommand,
  env: NodeJS.ProcessEnv = process.env,
): { executable: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    executable: env[RUNTIME_NODE_ENV]?.trim() || 'node',
    args: command.args,
    env: {
      ...Object.fromEntries(Object.entries(env).filter(([key, value]) => value !== undefined && !key.startsWith('DYLD_'))),
      PATH: developerPath(env.PATH),
      ELECTRON_RUN_AS_NODE: '1',
      GIT_TERMINAL_PROMPT: '0',
      GIT_PAGER: 'cat',
      PAGER: 'cat',
    },
  };
}

async function runCommand(root: string, command: RsiCommand, timeout: number): Promise<RsiValidationResult> {
  const resolved = validationCommand(command);
  try {
    const result = await execFileAsync(resolved.executable, resolved.args, {
      cwd: root,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: resolved.env,
    });
    return {
      command: [command.command, ...command.args].join(' '),
      status: 'passed',
      output: commandOutput(result.stdout, result.stderr),
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      command: [command.command, ...command.args].join(' '),
      status: 'failed',
      output: commandOutput(failure.stdout ?? '', failure.stderr ?? failure.message),
    };
  }
}

/** A passing suite is summarized by its verdict: the full log stays in the report file. A failure keeps
 * its output, because that is what the failure digest and the Agent's fix depend on. */
function summarizeValidation(result: RsiValidationResult): RsiValidationResult {
  return result.status === 'passed' ? { ...result, output: '' } : result;
}

/** Paths whose change makes `node --run app:build` meaningful: the web bundle the window serves and
 * the desktop package. A runtime-only change is fully covered by `node --run check`. */
function buildRelevant(paths: string[]) {
  return paths.some(path => path.startsWith('src/web/') || path.startsWith('desktop/')
    || path === 'package.json' || path === 'index.html' || path.startsWith('vite.config'));
}

/** Files that differ from a known commit. An unknown base means "assume it needs a build". */
function changedSince(root: string, base: string) {
  const result = git(root, ['diff', '--name-only', `${base}..HEAD`]);
  if (result.code !== 0) return null;
  return result.stdout.split('\n').map(line => line.trim()).filter(Boolean);
}

async function defaultValidate(input: { root: string; checks: RsiCommand[]; activate: boolean; needsBuild?: boolean }) {
  const results: RsiValidationResult[] = [];
  for (const check of input.checks) {
    const result = await runCommand(input.root, check, CHECK_TIMEOUT_MS);
    results.push(result);
    if (result.status === 'failed') return results;
  }
  // Custom checks give a fast inner loop while iterating. The full gate runs
  // before a change goes live, or whenever no custom check was supplied.
  if (input.checks.length && !input.activate) return results;
  const check = await runCommand(input.root, { command: 'node', args: ['--run', 'check'] }, CHECK_TIMEOUT_MS);
  results.push(check);
  if (check.status === 'failed' || !input.activate) return results;
  if (!input.needsBuild) return results;
  const appBuild: RsiCommand = { command: 'node', args: ['--run', 'app:build'] };
  const build = await runCommand(input.root, appBuild, BUILD_TIMEOUT_MS);
  if (build.status === 'passed' || !isEnvironmentFailure(build.output)) {
    results.push(build);
    return results;
  }
  // Only the packaging step is re-run here: `check` already passed and its verdict cannot change
  // because a download was interrupted. One retry, because a flake is what this fixes; a real
  // outage still fails, and the message says which of the two happened.
  const retry = await runCommand(input.root, appBuild, BUILD_TIMEOUT_MS);
  results.push(retry.status === 'passed'
    ? { ...retry, output: `app:build 第一次因网络/下载中断失败，已自动重跑一次并成功（与改动无关）。\n${retry.output}` }
    : { ...retry, output: `app:build 连续两次失败，其中至少一次是网络/下载问题，而不是改动本身。\n--- 第一次 ---\n${build.output}\n--- 第二次 ---\n${retry.output}` });
  return results;
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'change';
}

/** Realpath a candidate so symlinked checkouts compare equal to Git's top-level path. */
function resolveRoot(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function inside(root: string, path: string) {
  const target = resolve(root, path);
  const rel = relative(root, target);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
    ? rel.split(sep).join('/')
    : undefined;
}

function assertText(value: unknown, name: string, max: number, required = true) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (required && !text) throw new RuntimeError('invalid_input', `${name} is required`);
  if (text.length > max) throw new RuntimeError('invalid_input', `${name} must be at most ${max} characters`);
  return text;
}

/** The one key a change cannot omit, spelled the way the batch is accepted; `file`/`filePath` are
 * accepted because a batch written without one had to be resent whole. */
function changePath(body: Record<string, unknown>): unknown {
  return body['path'] ?? body['file'] ?? body['filePath'];
}

/** The model's own mistakes about the shape of `changes[]`, answered in its terms. The SDK validates the
 * call before this service sees it and prints every schema fact it finds (`changes.0.path: must have
 * required properties path`, followed by the received arguments) - accurate, and never a word about what
 * went wrong: a top-level field nested one level too deep, or a whole change written inside `edits[]`.
 * `prepareArguments` throws before that check and its message becomes the tool result the model reads.
 * A missing `path` is answered here too: it measured as the single most frequent mistake (a `replace`
 * entry carrying `edits` drops it), and the schema's wording never names the entry it lost. Everything
 * else that is only a field problem stays the schema's business. */
export function rsiChangeShapeHint(args: unknown): string | undefined {
  const top = plainObject(args);
  if (!top) return undefined;
  const topLevel = ['title', 'problem', 'evidence', 'diagnosis', 'impact', 'risk', 'checks', 'activate', 'force'];
  const changeKeys = ['path', 'action', 'content', 'edits', 'from'];
  for (const [index, change] of asArray(top['changes']).entries()) {
    if (Array.isArray(change)) return `changes[${index}] is an array: changes[] holds one object per file - flatten it.`;
    const entry = plainObject(change);
    if (!entry) continue;
    const stray = topLevel.find(key => Object.hasOwn(entry, key));
    if (stray) return `changes[${index}] is one file change: {path, action, content, edits}. "${stray}" belongs at the top level of the call - it is nested one level too deep.`;
    // Every change needs a path, whatever its action. The measured mistake is a `replace` entry that
    // carries `edits` and quietly drops `path`, and the SDK answers only "must have required
    // properties path" - no index, no shape, so the same call comes back. Name it here instead.
    if (typeof entry['path'] !== 'string') {
      return `changes[${index}] is missing "path": every change needs one path per file. Write it as `
        + '{path, action: "write", content} | {path, action: "replace", edits: [{oldText, newText}]}'
        + ' | {path, action: "copy", from: "<revision>"} | {path, action: "delete"}.';
    }
    // A mirror names a revision instead of retyping content. Shape mistakes in that one field are
    // answered here, before any file is touched, by the same rule the parser enforces.
    if (entry['action'] === 'copy') {
      const refusal = revisionRefusal(entry['from']);
      if (refusal) return `changes[${index}].from ${refusal}`;
    }
    for (const [editIndex, edit] of asArray(entry['edits']).entries()) {
      if (Array.isArray(edit)) return `changes[${index}].edits[${editIndex}] is an array: edits[] holds one {oldText, newText} per edit - flatten it.`;
      const edited = plainObject(edit);
      if (!edited) continue;
      const nested = changeKeys.find(key => Object.hasOwn(edited, key));
      if (nested) return `changes[${index}].edits[${editIndex}] is one edit: {oldText, newText}. A change object {path, action, ...} belongs in changes[], not inside edits[] - one change is nested inside another.`;
    }
  }
  for (const [index, check] of asArray(top['checks']).entries()) {
    const entry = plainObject(check);
    if (entry && changeKeys.some(key => Object.hasOwn(entry, key))) {
      return `checks[${index}] is one check: {command, args}. A file change belongs in changes[], not in checks[].`;
    }
  }
  return undefined;
}

/** A JSON object as the model sends it; arrays and scalars are not a shape mistake. */
function plainObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Names the shape, not just the missing key: a resend must not need a second guess. */
function changePathText(body: Record<string, unknown>, index: number): string {
  const raw = changePath(body);
  const path = typeof raw === 'string' ? raw.trim() : '';
  if (!path) {
    throw new RuntimeError(
      'invalid_input',
      `changes[${index}].path is required: each change is `
      + '{path, action: "write", content} | {path, action: "replace", edits: [{oldText, newText}]} | {path, action: "delete"}',
    );
  }
  if (path.length > 1_000) throw new RuntimeError('invalid_input', `changes[${index}].path must be at most 1000 characters`);
  return path;
}

function normalizeChange(value: unknown, index: number): RsiFileChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('invalid_input', `changes[${index}] must be an object`);
  }
  const body = value as Record<string, unknown>;
  const path = changePathText(body, index);
  if (body.action === 'write') {
    if (typeof body.content !== 'string') throw new RuntimeError('invalid_input', `changes[${index}].content must be a string`);
    return { path, action: 'write', content: body.content };
  }
  if (body.action === 'copy') {
    // A mirror is "this file exactly as that revision has it". Retyping the content instead is what
    // silently drops a line, and the drop surfaces minutes later as an unrelated-looking check
    // failure - so the revision is named and the content is read out of it, byte for byte.
    const refusal = revisionRefusal(body.from);
    if (refusal) throw new RuntimeError('invalid_input', `changes[${index}].from ${refusal}`);
    return { path, action: 'copy', from: String(body.from).trim() };
  }
  if (body.action === 'delete') return { path, action: 'delete' };
  if (body.action !== 'replace' || !Array.isArray(body.edits) || !body.edits.length) {
    throw new RuntimeError('invalid_input', `changes[${index}] must be write, replace, copy or delete`);
  }
  const edits = body.edits.map((edit, editIndex) => {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) {
      throw new RuntimeError('invalid_input', `changes[${index}].edits[${editIndex}] must be an object`);
    }
    const record = edit as Record<string, unknown>;
    if (typeof record.oldText !== 'string' || !record.oldText) {
      throw new RuntimeError('invalid_input', `changes[${index}].edits[${editIndex}].oldText must be nonempty`);
    }
    if (typeof record.newText !== 'string') {
      throw new RuntimeError('invalid_input', `changes[${index}].edits[${editIndex}].newText must be a string`);
    }
    return { oldText: record.oldText, newText: record.newText };
  });
  return { path, action: 'replace', edits };
}

function normalizeChecks(value: unknown) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new RuntimeError('invalid_input', 'checks must be an array');
  return value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new RuntimeError('invalid_input', `checks[${index}] must be an object`);
    }
    const record = item as Record<string, unknown>;
    if (record.command !== 'node') throw new RuntimeError('invalid_input', `checks[${index}].command must be "node"`);
    if (!Array.isArray(record.args) || record.args.some(arg => typeof arg !== 'string' || arg.length > 1_000)) {
      throw new RuntimeError('invalid_input', `checks[${index}].args must be a string array`);
    }
    return { command: 'node' as const, args: record.args as string[] };
  });
}

function failureReport(input: RsiChangeInput, root: string | null, error: string, validation: RsiValidationResult[] = []) {
  return [
    `### RSI 变更失败：${input.title}`,
    '',
    `- 问题：${input.problem}`,
    `- 目标：${root ?? '不可用'}`,
    `- 原因：${error}`,
    ...(validation.length ? ['- 验证：', ...validation.map(item => `  - ${item.command}: ${item.status}`), ...failureDigest(validation)] : []),
  ].join('\n');
}

function checksFailedReport(input: RsiChangeInput, receipt: Omit<RsiReceipt, 'report'>) {
  return [
    `### RSI 检查未通过，改动已保留：${input.title}`,
    '',
    `- 问题：${input.problem}`,
    ...(input.diagnosis ? [`- 诊断：${input.diagnosis}`] : []),
    `- 分支：${receipt.branch ?? 'unknown'}`,
    `- 保留文件：${(receipt.pendingFiles ?? []).join(', ') || '（无文件改动）'}`,
    '- 验证：',
    ...receipt.validation.map(item => `  - ${item.command}: ${item.status}`),
    ...failureDigest(receipt.validation),
    '',
    '改动仍在工作区、尚未提交，也不会触发重载。继续修复后再次调用 apply_rsi_change 即可（可用 changes: [] 只重跑检查）。',
  ].join('\n');
}

function unavailableReport(input: RsiChangeInput, root: string | null, reason: string) {
  return [
    `### RSI 不可用：${input.title}`,
    '',
    `- 问题：${input.problem}`,
    `- 目标：${root ?? '未找到'}`,
    `- 原因：${reason}`,
  ].join('\n');
}

export interface RsiActivation {
  state: 'saved' | 'pending_reload' | 'active' | 'checked_only';
  /** One honest sentence for the report, so a reader need not go to the filesystem. */
  note: string;
}

/**
 * What this call actually did about the running daemon.
 *
 * HB-179: a call with no changes committed nothing yet was reported as `applied` with activation
 * `active` and the note "该提交已是运行中的版本，无需重载" — while the source checkout did not hold the
 * commit at all. `active` says "what you asked for is running", and a check-only call has no right to
 * say it. The rule here is that the state is derived from THIS call's commit, never from HEAD alone.
 */
export function describeActivation(input: {
  commit: string | null;
  /** Whether THIS call created the commit. A pre-existing HEAD is not a delivery. */
  committedNow: boolean;
  activate: boolean;
  /** Whether the daemon already runs `commit`. */
  live: boolean;
}): RsiActivation {
  if (!input.activate) {
    return { state: 'saved', note: input.committedNow ? '仅保存，未重载' : '未重载，且这次调用没有产生提交' };
  }
  if (!input.committedNow || !input.commit) {
    // The honest case the receipt used to hide: checks ran, nothing was delivered, so claiming a
    // running version would be a statement about work that does not exist.
    return {
      state: 'checked_only',
      note: '这次调用只跑了检查，没有产生提交：源码是否需要更新，请自己核对后再判断。',
    };
  }
  if (input.live) return { state: 'active', note: '这次提交已在运行中的版本里，无需重载' };
  return { state: 'pending_reload', note: '已安排重载' };
}

function successReport(input: RsiChangeInput, receipt: Omit<RsiReceipt, 'report'>, activationNote: string) {
  return [
    `### RSI 已提交：${input.title}`,
    '',
    `- 问题：${input.problem}`,
    ...(input.evidence ? [`- 证据：${input.evidence}`] : []),
    ...(input.diagnosis ? [`- 诊断：${input.diagnosis}`] : []),
    ...(input.impact ? [`- 影响：${input.impact}`] : []),
    ...(input.risk ? [`- 风险：${input.risk}`] : []),
    `- 分支：${receipt.branch ?? 'unknown'}`,
    `- 提交：${receipt.commit ?? 'unknown'}`,
    `- 文件：${receipt.files.join(', ')}`,
    '- 验证：',
    ...receipt.validation.map(item => `  - ${item.command}: ${item.status}`),
    ...(receipt.outputPath ? [`- 完整日志：${receipt.outputPath}`] : []),
    ...failureDigest(receipt.validation),
    `- 激活：${activationNote}`,
    ...(receipt.restartRequired ? ['- 当前回合已结束；等待宿主重载确认后才能报告“已生效”。'] : []),
    ...(receipt.diff ? ['', '```diff', receipt.diff, '```'] : []),
  ].join('\n');
}

async function diffFor(root: string, commit: string) {
  try {
    const result = await execFileAsync('git', ['show', '--format=', '--no-ext-diff', '--unified=3', commit], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 20 * 1024 * 1024,
    });
    const diff = String(result.stdout).trim();
    return diff.length > MAX_REPORT_DIFF ? `${diff.slice(0, MAX_REPORT_DIFF)}\n... diff truncated ...` : diff;
  } catch {
    return undefined;
  }
}

export class RsiService {
  readonly root: string | undefined;
  /** True when the root is a usable Graph Git checkout right now. */
  readonly available: boolean;
  private readonly stateDir: string;
  private readonly validate: NonNullable<RsiServiceOptions['validate']>;
  private readonly runningCommit: string | null;
  private changing = false;

  constructor(options: RsiServiceOptions) {
    this.root = options.root ? resolveRoot(options.root) : undefined;
    this.stateDir = resolve(options.stateDir);
    this.validate = options.validate ?? defaultValidate;
    this.available = Boolean(
      this.root && existsSync(join(this.root, 'package.json')) && detectRepo(this.root) === this.root,
    );
    this.runningCommit = this.available ? revParse(this.root!, 'HEAD') ?? null : null;
  }

  private restartPath() {
    return join(this.stateDir, 'rsi', 'restart.json');
  }

  private workingPath() {
    return join(this.stateDir, 'rsi', 'working.json');
  }

  /**
   * Uncommitted paths in the checkout. Checks run against the working tree, so a path here that the
   * commit would not contain makes a green run prove the wrong thing.
   */
  private dirtyPaths(root: string) {
    return [...new Set([
      ...git(root, ['diff', '--name-only', 'HEAD']).stdout.split('\n'),
      ...git(root, ['ls-files', '--others', '--exclude-standard']).stdout.split('\n'),
    ].map(path => path.trim()).filter(Boolean))].sort();
  }

  private rsiDirtyError(root: string, blocked: string[]) {
    return new RuntimeError('rsi_dirty', rsiDirtyMessage(root, blocked));
  }

  /** Keep queued work intact while the desktop drains existing operations. */
  hasPendingRestart() { return existsSync(this.restartPath()); }

  /** Full check output for one attempt, kept out of the receipt that the conversation stores. */
  private async writeReportFile(id: string, validation: RsiValidationResult[]) {
    const directory = join(this.stateDir, 'rsi', 'reports');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${id}.log`);
    await writeFile(path, validation.map(item => `$ ${item.command}\n[${item.status}]\n${item.output}\n`).join('\n'), { mode: 0o600 });
    return path;
  }

  async status(): Promise<RsiStatus> {
    const root = this.available && this.root ? this.root : null;
    const available = this.available;
    const branch = available ? checkedOutBranch(root!) ?? null : null;
    const pendingRestart = await this.readRestart();
    let lastActivation: RsiStatus['lastActivation'] = null;
    try { lastActivation = JSON.parse(await readFile(join(this.stateDir, 'rsi', 'activated.json'), 'utf8')) as RsiStatus['lastActivation']; }
    catch { /* No confirmed reload yet. */ }
    let activeOperations = 0;
    let operations: RsiStatus['operations'] = [];
    let operationsKnown = true;
    const dbPath = join(this.stateDir, 'tasks.sqlite');
    if (existsSync(dbPath)) {
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(dbPath, { readOnly: true });
        operations = (db.prepare(`
          SELECT o.id, o.task_id AS taskId, o.node_id AS nodeId, o.state,
                 t.request AS request, t.conversation_id AS conversationId,
                 CASE WHEN c.archived_at IS NULL THEN 0 ELSE 1 END AS archived
          FROM operations o
          JOIN tasks t ON t.id=o.task_id
          LEFT JOIN conversations c ON c.id=t.conversation_id
          WHERE o.state IN ('intent','dispatched')
          ORDER BY o.rowid
        `).all() as {
          id: string; taskId: string; nodeId: string; state: string;
          request: string; conversationId: string | null; archived: number;
        }[]).map(row => ({
          id: row.id,
          taskId: row.taskId,
          nodeId: row.nodeId,
          state: row.state,
          request: row.request,
          conversationId: row.conversationId,
          archived: Boolean(row.archived),
        }));
        activeOperations = operations.length;
        db.close();
      } catch {
        activeOperations = 0;
        operations = [];
        // The ledger exists but could not be read; never reload on an unknown count.
        operationsKnown = false;
      }
    }
    return {
      available,
      root,
      branch,
      ...(available ? {} : { reason: this.unavailableReason() }),
      sync: available && root ? this.syncState(root) : null,
      pendingRestart,
      lastActivation,
      activeOperations,
      operations,
      operationsKnown,
      // A forced request reloads even with operations in flight; a normal one
      // waits for the ledger to drain.
      canRestart: Boolean(pendingRestart
        && (pendingRestart.force === true || (operationsKnown && activeOperations === 0))),
    };
  }

  /**
   * Which local branches are ahead of the copy they were published to, which of those are local work
   * lines that are never published, and how many were never published at all.
   *
   * This exists because unpublished work is otherwise silent: the application line sat 61 commits
   * ahead of its remote across several sessions and nothing in the harness said so, so a broken push
   * channel looked exactly like a working one.
   */
  private syncState(root: string) {
    const heads = git(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (heads.code !== 0) return { unpublished: [], expected: [], localOnly: 0, note: '无法读取本地分支，未计算未发布的提交' };
    const unpublished: { branch: string; upstream: string; ahead: number; behind: number }[] = [];
    const expected: { branch: string; upstream: string; ahead: number; behind: number }[] = [];
    let localOnly = 0;
    for (const branch of heads.stdout.split('\n').map(name => name.trim()).filter(Boolean)) {
      const upstream = `origin/${branch}`;
      if (git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${upstream}`]).code !== 0) {
        localOnly += 1;
        continue;
      }
      const counts = git(root, ['rev-list', '--left-right', '--count', `refs/remotes/${upstream}...${branch}`]);
      if (counts.code !== 0) continue;
      const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
      if (!Number.isFinite(ahead) || !Number.isFinite(behind) || (ahead === 0 && behind === 0)) continue;
      const entry = { branch, upstream, ahead: ahead as number, behind: behind as number };
      (branch.startsWith('rsi/') ? expected : unpublished).push(entry);
    }
    unpublished.sort((left, right) => left.branch.localeCompare(right.branch));
    expected.sort((left, right) => left.branch.localeCompare(right.branch));
    // Debt first when there is any, so the actionable line is never buried behind a standing one.
    const parts: string[] = [
      unpublished.length
        ? `未发布：${unpublished.map(item => `${item.branch} 领先 ${item.upstream} ${item.ahead} 个提交`).join('；')}`
        : '没有未发布的已发布分支',
    ];
    if (expected.length) {
      parts.push(`本机自改进线按设计不推送：${expected.map(item => `${item.branch} 领先 ${item.upstream} ${item.ahead} 个提交`).join('；')}`);
    }
    if (localOnly) parts.push(`另有 ${localOnly} 个本地分支从未发布`);
    const note = parts.join('；');
    return { unpublished, expected, localOnly, note };
  }

  private unavailableReason() {
    if (!this.root) {
      return 'No Graph source checkout was found. Set GRAPH_RSI_ROOT to the checkout the app runs from.';
    }
    if (!existsSync(join(this.root, 'package.json'))) {
      return `${this.root} has no package.json, so it is not a Graph source checkout.`;
    }
    return `${this.root} is not a Git checkout root; run Graph from a source checkout to enable self-improvement.`;
  }

  /**
   * Clear a pending restart once the host has actually reloaded the daemon for
   * that exact request. A stale id never clears a newer request, so a crashed
   * restart keeps its intent instead of silently dropping it.
   */
  async ackRestart(id: string, store: TaskStore): Promise<{ cleared: boolean; pendingRestart: RsiStatus['pendingRestart'] }> {
    const current = await this.readRestart();
    if (!current || current.id !== id) return { cleared: false, pendingRestart: current };
    const { generation } = store.db.prepare('SELECT generation FROM runtime').get() as { generation: number };
    // A matching HTTP response alone is not proof: the daemon must have
    // restarted onto the requested commit, rather than still running old code.
    if (current.root !== this.root || current.commit !== this.runningCommit
      || (current.generation !== undefined && generation <= current.generation)) {
      return { cleared: false, pendingRestart: current };
    }
    const confirmed = { id, commit: current.commit, confirmedAt: Date.now(), generation };
    store.transaction(() => {
      const messages = store.db.prepare("SELECT id,conversation_id,text,data FROM messages WHERE kind='rsi' AND json_extract(data,'$.id')=?").all(id) as { id: string; conversation_id: string; text: string; data: string }[];
      for (const message of messages) {
        const receipt = JSON.parse(message.data) as RsiReceipt;
        if (receipt.activation?.state === 'active') continue;
        receipt.activation = { state: 'active', confirmedAt: confirmed.confirmedAt, generation };
        receipt.report = `${message.text}\n\n- 重载已确认：提交 ${current.commit} 已生效。`;
        appendMessage(store, { conversationId: message.conversation_id, messageId: message.id, role: 'system', kind: 'rsi', text: receipt.report, data: receipt as unknown as Json, state: 'done' });
        const taskId = (store.db.prepare('SELECT anchor_task_id FROM conversations WHERE id=?').get(message.conversation_id) as { anchor_task_id: string }).anchor_task_id;
        store.event(taskId, 'rsi.activated', confirmed);
      }
      confirmRsiContinuation(store, id);
    });
    await writeAtomic(join(this.stateDir, 'rsi', 'activated.json'), JSON.stringify(confirmed));
    await rm(this.restartPath(), { force: true });
    return { cleared: true, pendingRestart: null };
  }

  private async readRestart(): Promise<RsiStatus['pendingRestart']> {
    try {
      const parsed = JSON.parse(await readFile(this.restartPath(), 'utf8')) as RsiStatus['pendingRestart'];
      return parsed && typeof parsed.id === 'string' && typeof parsed.root === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * Files a previous failed attempt left uncommitted. They stay editable so the
   * Main Agent can keep fixing the same change instead of losing it to a flaky
   * check, while unrelated user edits still block the change set.
   */
  private async readWorking(): Promise<{ branch: string; paths: string[] } | null> {
    try {
      const parsed = JSON.parse(await readFile(this.workingPath(), 'utf8')) as { branch?: unknown; paths?: unknown };
      if (typeof parsed.branch !== 'string' || !Array.isArray(parsed.paths)) return null;
      return { branch: parsed.branch, paths: parsed.paths.filter((path): path is string => typeof path === 'string') };
    } catch {
      return null;
    }
  }

  private async writeWorking(branch: string, paths: string[]) {
    await writeAtomic(this.workingPath(), `${JSON.stringify({ branch, paths: [...new Set(paths)].sort() }, null, 2)}\n`);
  }

  async apply(input: RsiChangeInput, context: RsiApplyContext): Promise<RsiReceipt> {
    if (this.changing) throw new RuntimeError('rsi_busy', 'Another RSI change is still being validated.');
    this.changing = true;
    try { return await this.applyChange(input, context); }
    finally { this.changing = false; }
  }

  private async applyChange(input: RsiChangeInput, context: RsiApplyContext): Promise<RsiReceipt> {
    const title = assertText(input.title, 'title', 200);
    const problem = assertText(input.problem, 'problem', 4_000);
    const evidence = input.evidence ? assertText(input.evidence, 'evidence', 4_000, false) : undefined;
    const diagnosis = input.diagnosis ? assertText(input.diagnosis, 'diagnosis', 4_000, false) : undefined;
    const impact = input.impact ? assertText(input.impact, 'impact', 4_000, false) : undefined;
    const risk = input.risk ? assertText(input.risk, 'risk', 4_000, false) : undefined;
    const normalized: RsiChangeInput = {
      title,
      problem,
      ...(evidence ? { evidence } : {}),
      ...(diagnosis ? { diagnosis } : {}),
      ...(impact ? { impact } : {}),
      ...(risk ? { risk } : {}),
      changes: Array.isArray(input.changes) ? input.changes.map(normalizeChange) : [],
      checks: normalizeChecks(input.checks),
      activate: input.activate !== false,
      ...(input.force === true ? { force: true } : {}),
    };
    const checks = normalized.checks ?? [];

    const id = randomUUID();
    const root = this.root;
    if (!this.available || !root) {
      const error = this.unavailableReason();
      const receipt: RsiReceipt = {
        id, status: 'unavailable', title, root: root ?? null, branch: null, commit: null,
        files: [], validation: [], restartRequired: false, error,
        report: unavailableReport(normalized, root ?? null, error),
      };
      this.record(context, receipt);
      return receipt;
    }

    const paths = normalized.changes.map(change => inside(root, change.path));
    if (paths.some(path => !path || path.split('/').includes('.git'))) {
      throw new RuntimeError('invalid_input', 'RSI paths must stay inside the Graph source root and must not target .git');
    }
    const uniquePaths = [...new Set(paths as string[])];
    if (uniquePaths.length !== paths.length) throw new RuntimeError('invalid_input', 'RSI changes must use unique file paths');
    if (this.hasPendingRestart()) throw new RuntimeError('rsi_reload_pending', 'RSI is waiting for reload confirmation. End this turn before starting another improvement.');

    const originalHead = revParse(root, 'HEAD');
    if (!originalHead) throw new RuntimeError('rsi_unavailable', 'Graph source checkout has no Git HEAD');
    const originalBranch = checkedOutBranch(root);
    const branch = originalBranch?.startsWith('rsi/')
      ? originalBranch
      : `rsi/${slug(title)}-${id.slice(0, 8)}`;

    // A failed attempt keeps its files uncommitted so the Agent can keep fixing
    // them. Those paths stay editable; unrelated user edits still block.
    const working = await this.readWorking();
    const owned = new Set(working && working.branch === branch ? working.paths : []);
    // An empty change list is valid when there is pending work to re-check or a
    // custom check to run; the default validation always runs anyway.
    if (!normalized.changes.length && !checks.length && !owned.size) {
      throw new RuntimeError('invalid_input', 'Provide at least one file change or one check to run');
    }
    // Checks run against the whole working tree, so a green run only proves the commit when the
    // commit contains everything that was dirty while they ran. Anything else is refused up front
    // instead of being silently left out of the commit that gets reported as verified.
    // An unowned dirty path is somebody else's uncommitted work: overwriting a target would destroy
    // it, and verifying a bystander would report a commit that does not contain it.
    const unownedDirty = () => this.dirtyPaths(root).filter(path => !owned.has(path));
    const blocked = unownedDirty();
    if (blocked.length) throw this.rsiDirtyError(root, blocked);

    let createdBranch = false;
    if (branch !== originalBranch) {
      const switched = git(root, ['switch', '-c', branch]);
      if (switched.code !== 0) throw new RuntimeError('rsi_git', switched.stderr || `Failed to create ${branch}`);
      createdBranch = true;
    }

    const snapshots = new Map<string, string | undefined>();
    try {
      const final = new Map<string, string | undefined>();
      for (const change of normalized.changes) {
        const path = inside(root, change.path)!;
        const absolute = join(root, path);
        const existing = snapshots.has(path)
          ? snapshots.get(path)
          : await readFile(absolute, 'utf8').catch(error => {
              if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
              throw error;
            });
        snapshots.set(path, existing);
        if (change.action === 'write') {
          final.set(path, change.content);
        } else if (change.action === 'copy') {
          const shown = gitRaw(root, ['show', `${change.from}:${path}`]);
          if (shown.code !== 0) {
            throw new RuntimeError('rsi_edit_conflict', `RSI copy of ${path} from ${change.from} found no such file in that revision`
              + `${shown.stderr.trim() ? `: ${shown.stderr.trim().split('\n')[0]}` : ''}`
              + '；检查两边是不是同一个仓库（13-Graph 与 live 检出是同一仓库的链接 worktree，对方的提交直接可见）');
          }
          final.set(path, shown.stdout);
        } else if (change.action === 'delete') {
          final.set(path, undefined);
        } else {
          if (existing === undefined) throw new RuntimeError('not_found', `Cannot replace missing RSI file ${path}`);
          let content = existing;
          for (const [index, edit] of change.edits.entries()) {
            const matches = content.split(edit.oldText).length - 1;
            if (matches !== 1) {
              // A batch rolls back as a whole, so name the edit that failed: the
              // caller has to know which oldText to correct without guessing.
              const head = edit.oldText.split('\n')[0]!.trim().slice(0, 90);
              // Which state the anchor was matched against is the part the caller cannot see: a failed
              // attempt keeps its files uncommitted, so the committed text is already gone from the
              // worktree and "found 0" on its own reads like a typo instead of a stale anchor.
              const hint = owned.has(path)
                ? '；该文件当前是上一轮未提交（检查失败保留）的内容：oldText 要按它现在的样子匹配，或改用 action "write" 直接给全文'
                : '';
              throw new RuntimeError('rsi_edit_conflict', `RSI replacement in ${path} must match exactly once, found ${matches} (edit ${index + 1} of ${change.edits.length}, first line: ${head})${hint}`);
            }
            content = content.replace(edit.oldText, edit.newText);
          }
          final.set(path, content);
        }
      }

      for (const [path, content] of final) {
        const absolute = join(root, path);
        if (content === undefined) {
          await rm(absolute, { force: true });
          continue;
        }
        await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
        await writeFile(absolute, content, { mode: 0o644 });
      }

      // `app:build` only matters when the served page or the desktop package can move; a runtime-only
      // change is fully covered by `node --run check`, and rebuilding would overwrite the bundle the
      // running window serves with this checkout's own build.
      const changedPaths = this.runningCommit ? changedSince(root, this.runningCommit) : null;
      const needsBuild = changedPaths === null || buildRelevant([...uniquePaths, ...owned, ...changedPaths]);
      const raw = await this.validate({
        root,
        checks,
        activate: normalized.activate === true,
        needsBuild,
      });
      const outputPath = await this.writeReportFile(id, raw);
      const validation = raw.map(summarizeValidation);
      const failed = validation.find(result => result.status === 'failed');
      if (failed) {
        // Keep the working tree so the Agent can iterate; a flaky or genuinely
        // failing check must not discard the change.
        const pendingFiles = [...new Set([...owned, ...uniquePaths])].sort();
        await this.writeWorking(branch, pendingFiles);
        const base: Omit<RsiReceipt, 'report'> = {
          id, status: 'checks_failed', title, root, branch, commit: null,
          files: uniquePaths, validation, restartRequired: false, pendingFiles, outputPath,
        };
        const receipt: RsiReceipt = { ...base, report: checksFailedReport(normalized, base) };
        this.record(context, receipt);
        return receipt;
      }

      // The checks just ran against the working tree, so they verified every path that is dirty
      // here: a run that leaves the checkout dirty must not be committed as if it were green.
      // Paths this attempt wrote are expected to be dirty; anything else was verified by the checks
      // but would stay out of the commit, so the green run must not become a commit.
      const unverified = this.dirtyPaths(root).filter(path => !owned.has(path) && !uniquePaths.includes(path));
      if (unverified.length) throw this.rsiDirtyError(root, unverified);

      // Commit every path this attempt or a prior attempt owns, so a checks-only
      // re-run still lands the pending files. Stage only paths that exist now or
      // were tracked before, so a delete of a never-tracked file cannot fail.
      const commitPaths = [...new Set([...uniquePaths, ...owned])].sort();
      const tracked = new Set(git(root, ['ls-files', '--', ...commitPaths]).stdout.split('\n').filter(Boolean));
      const stagePaths = commitPaths.filter(path => tracked.has(path) || existsSync(join(root, path)));
      let commit = revParse(root, 'HEAD') ?? null;
      let committedNow = false;
      if (stagePaths.length) {
        const staged = git(root, ['add', '-A', '--', ...stagePaths]);
        if (staged.code !== 0) throw new RuntimeError('rsi_git', staged.stderr || 'Failed to stage RSI changes');
        const committed = git(root, ['commit', '--no-verify', '-m', `rsi: ${title}`, '--', ...stagePaths]);
        if (committed.code !== 0) throw new RuntimeError('rsi_git', committed.stderr || 'Failed to commit RSI changes');
        commit = revParse(root, 'HEAD') ?? null;
        if (!commit) throw new RuntimeError('rsi_git', 'RSI commit did not produce a HEAD');
        committedNow = true;
      }
      await rm(this.workingPath(), { force: true });

      // Activation exists to put a new commit into the running daemon. When this call committed
      // nothing and the daemon already runs HEAD (a checks-only re-run, for example), a reload would
      // only interrupt the user, so it is skipped and reported as such.
      const live = commit !== null && commit === this.runningCommit;
      const restartRequired = normalized.activate === true && !live;
      if (restartRequired) {
        await writeAtomic(this.restartPath(), `${JSON.stringify({
          id, root, branch, commit, requestedAt: Date.now(),
          generation: (context.store.db.prepare('SELECT generation FROM runtime').get() as { generation: number }).generation,
          ...(normalized.force ? { force: true } : {}),
        }, null, 2)}\n`);
      }
      const diff = committedNow && commit ? await diffFor(root, commit) : undefined;
      const described = describeActivation({ commit, committedNow, activate: normalized.activate === true, live });
      const base: Omit<RsiReceipt, 'report'> = {
        id,
        status: 'applied',
        title,
        root,
        branch,
        commit,
        files: stagePaths,
        validation,
        restartRequired,
        activation: { state: described.state },
        ...(outputPath ? { outputPath } : {}),
        ...(normalized.force ? { force: true } : {}),
        ...(diff ? { diff } : {}),
      };
      const receipt: RsiReceipt = { ...base, report: successReport(normalized, base, described.note) };
      this.record(context, receipt);
      return receipt;
    } catch (error) {
      for (const [path, content] of snapshots) {
        const absolute = join(root, path);
        if (content === undefined) await rm(absolute, { force: true });
        else {
          await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
          await writeFile(absolute, content, { mode: 0o644 });
        }
      }
      // Restoring the files leaves the index alone, and an index entry outlives the attempt that made it:
      // `git add -A -- good ignored` stages the good path and then fails on the ignored one, so a
      // rolled-back call used to leave `A good` behind - which the next attempt reads as somebody else's
      // uncommitted work ("Uncommitted changes outside this RSI change") and refuses to run. The harness
      // never starts with unowned dirty paths, so resetting these can only undo our own staging.
      const touched = [...new Set([...uniquePaths, ...owned])];
      if (touched.length) git(root, ['reset', '-q', '--', ...touched]);
      // Restore only what this attempt wrote; keep files a prior failed attempt
      // still owns so its fix is not lost either.
      if (owned.size) await this.writeWorking(branch, [...owned]);
      else await rm(this.workingPath(), { force: true });
      if (createdBranch && originalBranch && !owned.size) {
        git(root, ['switch', originalBranch]);
        git(root, ['branch', '-D', branch]);
      }
      const message = error instanceof Error ? error.message : String(error);
      const receipt: RsiReceipt = {
        id,
        status: 'rolled_back',
        title,
        root,
        branch: originalBranch ?? null,
        commit: null,
        files: uniquePaths,
        validation: [],
        restartRequired: false,
        error: message,
        report: failureReport(normalized, root, message),
      };
      this.record(context, receipt);
      return receipt;
    }
  }

  private record(context: RsiApplyContext, receipt: RsiReceipt) {
    context.store.transaction(() => {
      if (receipt.restartRequired && receipt.commit && context.operationId) {
        awaitRsiReload(context.store, receipt.id, context.operationId, receipt.commit);
      }
      context.store.event(context.taskId, 'rsi.change', receipt as unknown as Json);
      const conversation = context.conversationId
        ? { id: context.conversationId }
        : conversationForTask(context.store, context.taskId);
      if (!conversation) return;
      appendMessage(context.store, {
        conversationId: conversation.id,
        role: 'system',
        kind: 'rsi',
        operationId: context.operationId ?? null,
        text: receipt.report,
        data: receipt as unknown as Json,
        state: 'done',
      });
      // Scheduling a reload drains the daemon, which can close the Agent process
      // before the turn settles. The turn's visible receipt is therefore written
      // here, while the reload is only requested, so the user always sees the
      // outcome of the change and never has to ask for it again. The adapter
      // returns the same text, and recordConversationOutput is idempotent per
      // operation, so a turn that does settle adds nothing twice.
      if (receipt.restartRequired) {
        appendMessage(context.store, {
          conversationId: conversation.id,
          role: 'assistant',
          kind: 'chat',
          text: RSI_RELOAD_RECEIPT,
          data: { reloadReceipt: true },
          state: 'done',
          operationId: context.operationId ?? null,
        });
        markOperationReplied(context.store, context.operationId);
      }
    });
  }
}

const services = new Map<string, RsiService>();

export function resolveRsiRoot(env: Record<string, string | undefined> = process.env, cwd = process.cwd()) {
  const configured = env.GRAPH_RSI_ROOT?.trim();
  if (configured) return resolveRoot(configured);
  for (const candidate of [cwd, graphApplicationRoot()]) {
    const root = resolveRoot(candidate);
    if (existsSync(join(root, 'package.json')) && detectRepo(root) === root) return root;
  }
  return undefined;
}

export function openRsiService(options: RsiServiceOptions) {
  const key = `${options.root ?? 'unavailable'}\0${resolve(options.stateDir)}`;
  const existing = services.get(key);
  if (existing) return existing;
  const service = new RsiService(options);
  services.set(key, service);
  return service;
}

/**
 * Why a dirty path outside the requested change stops an RSI write, and what to do
 * about it. An Agent that edited the checkout by hand gets this instead of a
 * commit, so the message has to name the supported route: RSI edits must be
 * written by the tool, which is the only path that can attribute them to a
 * verified commit.
 */
export function rsiDirtyMessage(root: string, blocked: string[]): string {
  const paths = blocked.join(' ');
  return `Uncommitted changes outside this RSI change: ${blocked.join(', ')}. `
    + 'Checks run against the working tree, so they would verify changes that the commit does not contain. '
    + 'If you edited these files by hand, revert them and pass the same edits as changes to apply_rsi_change: '
    + 'RSI edits must be written by the tool, and a hand-committed tree cannot be attributed to a verified RSI commit. '
    + `To keep them as ordinary work instead, commit them first, for example \`git -C ${root} add -A -- ${paths} && git -C ${root} commit -m "wip"\`, `
    + `or revert them with \`git -C ${root} restore --staged --worktree -- ${paths}\`. `
    + 'Files left behind by an earlier failed RSI attempt on this branch are committed instead of reported.';
}
