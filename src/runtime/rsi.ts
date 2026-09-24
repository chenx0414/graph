import { awaitRsiReload, confirmRsiContinuation } from '../core/rsi-continuation.ts';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { appendMessage, conversationForTask, RSI_RELOAD_RECEIPT } from '../core/conversation.ts';
import type { TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { checkedOutBranch, detectRepo, git, revParse } from '../git/git.ts';
import { graphApplicationRoot } from './graph-root.ts';
import { RUNTIME_NODE_ENV } from './workspace-command.ts';

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
  activation?: { state: 'saved' | 'pending_reload' | 'active'; confirmedAt?: number; generation?: number };
  force?: boolean;
  /** Files left uncommitted by this or an earlier failed attempt, still fixable. */
  pendingFiles?: string[];
  error?: string;
  diff?: string;
  report: string;
  /** Full check output for this attempt, written outside the receipt the conversation stores. */
  outputPath?: string;
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

/** Locations a developer's shell puts on `PATH` but a desktop launch does not. */
const DEVELOPER_PATH_DIRECTORIES = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/sbin', '/usr/local/sbin'];

/** Keep the inherited order, then append the standard developer locations that
 * exist on this host. An app started from the desktop inherits launchd's minimal
 * `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`), where a check needing the developer's
 * own toolchain - `npm`, a package runner, a browser - fails before the work it
 * validates even starts. */
export function developerPath(inherited: string | undefined, exists: (path: string) => boolean = existsSync): string {
  const directories = (inherited ?? '').split(':').filter(Boolean);
  for (const directory of DEVELOPER_PATH_DIRECTORIES) {
    if (!directories.includes(directory) && exists(directory)) directories.push(directory);
  }
  return directories.join(':');
}

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
  results.push(await runCommand(input.root, { command: 'node', args: ['--run', 'app:build'] }, BUILD_TIMEOUT_MS));
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

function normalizeChange(value: unknown, index: number): RsiFileChange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RuntimeError('invalid_input', `changes[${index}] must be an object`);
  }
  const body = value as Record<string, unknown>;
  const path = assertText(body.path, `changes[${index}].path`, 1_000);
  if (body.action === 'write') {
    if (typeof body.content !== 'string') throw new RuntimeError('invalid_input', `changes[${index}].content must be a string`);
    return { path, action: 'write', content: body.content };
  }
  if (body.action === 'delete') return { path, action: 'delete' };
  if (body.action !== 'replace' || !Array.isArray(body.edits) || !body.edits.length) {
    throw new RuntimeError('invalid_input', `changes[${index}] must be write, replace or delete`);
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

function successReport(input: RsiChangeInput, receipt: Omit<RsiReceipt, 'report'>) {
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
    `- 激活：${receipt.restartRequired
      ? receipt.force ? '已安排强制重载（可能中断在途 operation）' : '已安排自动重载（等待在途 operation 结束）'
      : receipt.activation?.state === 'active' ? '该提交已是运行中的版本，无需重载' : '仅保存，未重载'}`,
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
    const paths = blocked.join(' ');
    return new RuntimeError('rsi_dirty',
      `Uncommitted changes outside this RSI change: ${blocked.join(', ')}. `
      + 'Checks run against the working tree, so they would verify changes that the commit does not contain. '
      + `Commit them first, for example \`git -C ${root} add -A -- ${paths} && git -C ${root} commit -m "wip"\`, `
      + `or revert them with \`git -C ${root} restore --staged --worktree -- ${paths}\`. `
      + 'Files left behind by an earlier failed RSI attempt on this branch are committed instead of reported.');
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
        } else if (change.action === 'delete') {
          final.set(path, undefined);
        } else {
          if (existing === undefined) throw new RuntimeError('not_found', `Cannot replace missing RSI file ${path}`);
          let content = existing;
          for (const edit of change.edits) {
            const matches = content.split(edit.oldText).length - 1;
            if (matches !== 1) {
              throw new RuntimeError('rsi_edit_conflict', `RSI replacement in ${path} must match exactly once, found ${matches}`);
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
        activation: { state: restartRequired ? 'pending_reload' : live && normalized.activate === true ? 'active' : 'saved' },
        ...(outputPath ? { outputPath } : {}),
        ...(normalized.force ? { force: true } : {}),
        ...(diff ? { diff } : {}),
      };
      const receipt: RsiReceipt = { ...base, report: successReport(normalized, base) };
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
          state: 'done',
          operationId: context.operationId ?? null,
        });
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
