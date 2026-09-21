import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { appendMessage, conversationForTask } from '../core/conversation.ts';
import type { TaskStore } from '../core/store.ts';
import { RuntimeError, type Json } from '../core/types.ts';
import { checkedOutBranch, detectRepo, git, revParse } from '../git/git.ts';
import { graphApplicationRoot } from './graph-root.ts';

const execFileAsync = promisify(execFile);
const MAX_CHANGE_BYTES = 10 * 1024 * 1024;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
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
}

export interface RsiValidationResult {
  command: string;
  status: 'passed' | 'failed';
  output: string;
}

export interface RsiReceipt {
  id: string;
  status: 'applied' | 'rolled_back' | 'unavailable';
  title: string;
  root: string | null;
  branch: string | null;
  commit: string | null;
  files: string[];
  validation: RsiValidationResult[];
  restartRequired: boolean;
  error?: string;
  diff?: string;
  report: string;
}

export interface RsiStatus {
  available: boolean;
  root: string | null;
  branch: string | null;
  pendingRestart: {
    id: string;
    root: string;
    branch: string | null;
    commit: string | null;
    requestedAt: number;
  } | null;
  activeOperations: number;
  /** False when the operation ledger could not be read, so a reload must wait. */
  operationsKnown: boolean;
  canRestart: boolean;
}

interface RsiServiceOptions {
  root?: string;
  stateDir: string;
  validate?: (input: { root: string; checks: RsiCommand[]; activate: boolean }) => Promise<RsiValidationResult[]>;
}

interface RsiApplyContext {
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

async function runCommand(root: string, command: RsiCommand, timeout: number): Promise<RsiValidationResult> {
  try {
    const result = await execFileAsync(command.command, command.args, {
      cwd: root,
      timeout,
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        PAGER: 'cat',
      },
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

async function defaultValidate(input: { root: string; checks: RsiCommand[]; activate: boolean }) {
  const results: RsiValidationResult[] = [];
  for (const check of input.checks) {
    const result = await runCommand(input.root, check, CHECK_TIMEOUT_MS);
    results.push(result);
    if (result.status === 'failed') return results;
  }
  const check = await runCommand(input.root, { command: 'node', args: ['--run', 'check'] }, CHECK_TIMEOUT_MS);
  results.push(check);
  if (check.status === 'failed' || !input.activate) return results;
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
    if (Buffer.byteLength(body.content, 'utf8') > MAX_FILE_BYTES) {
      throw new RuntimeError('invalid_input', `changes[${index}].content exceeds ${MAX_FILE_BYTES} bytes`);
    }
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
    ...(validation.length ? ['- 验证：', ...validation.map(item => `  - ${item.command}: ${item.status}`)] : []),
  ].join('\n');
}

function successReport(input: RsiChangeInput, receipt: Omit<RsiReceipt, 'report'>) {
  return [
    `### RSI 已应用：${input.title}`,
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
    `- 激活：${receipt.restartRequired ? '已安排自动重启' : '仅保存，未重启'}`,
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
  private readonly stateDir: string;
  private readonly validate: NonNullable<RsiServiceOptions['validate']>;

  constructor(options: RsiServiceOptions) {
    this.root = options.root ? resolveRoot(options.root) : undefined;
    this.stateDir = resolve(options.stateDir);
    this.validate = options.validate ?? defaultValidate;
  }

  private restartPath() {
    return join(this.stateDir, 'rsi', 'restart.json');
  }

  async status(): Promise<RsiStatus> {
    const root = this.root && existsSync(this.root) ? this.root : null;
    const available = Boolean(root && existsSync(join(root, 'package.json')) && detectRepo(root) === root);
    const branch = available ? checkedOutBranch(root!) ?? null : null;
    const pendingRestart = await this.readRestart();
    let activeOperations = 0;
    let operationsKnown = true;
    const dbPath = join(this.stateDir, 'tasks.sqlite');
    if (existsSync(dbPath)) {
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(dbPath, { readOnly: true });
        activeOperations = Number((db.prepare(
          "SELECT COUNT(*) AS count FROM operations WHERE state IN ('intent','dispatched')",
        ).get() as { count: number }).count);
        db.close();
      } catch {
        activeOperations = 0;
        // The ledger exists but could not be read; never reload on an unknown count.
        operationsKnown = false;
      }
    }
    return {
      available,
      root,
      branch,
      pendingRestart,
      activeOperations,
      operationsKnown,
      canRestart: Boolean(pendingRestart && operationsKnown && activeOperations === 0),
    };
  }

  /**
   * Clear a pending restart once the host has actually reloaded the daemon for
   * that exact request. A stale id never clears a newer request, so a crashed
   * restart keeps its intent instead of silently dropping it.
   */
  async ackRestart(id: string): Promise<{ cleared: boolean; pendingRestart: RsiStatus['pendingRestart'] }> {
    const current = await this.readRestart();
    if (!current || current.id !== id) return { cleared: false, pendingRestart: current };
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

  async apply(input: RsiChangeInput, context: RsiApplyContext): Promise<RsiReceipt> {
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
    };
    if (!normalized.changes.length) throw new RuntimeError('invalid_input', 'At least one RSI file change is required');
    const totalBytes = normalized.changes.reduce((sum, change) =>
      sum + (change.action === 'write' ? Buffer.byteLength(change.content, 'utf8') : 0), 0);
    if (totalBytes > MAX_CHANGE_BYTES) throw new RuntimeError('invalid_input', `RSI change set exceeds ${MAX_CHANGE_BYTES} bytes`);

    const id = randomUUID();
    const root = this.root;
    if (!root || !existsSync(join(root, 'package.json')) || detectRepo(root) !== root) {
      const error = 'Graph source checkout is unavailable; set GRAPH_RSI_ROOT to a clean Graph Git checkout';
      const receipt: RsiReceipt = {
        id, status: 'unavailable', title, root: root ?? null, branch: null, commit: null,
        files: [], validation: [], restartRequired: false, error,
        report: failureReport(normalized, root ?? null, error),
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

    const dirty = git(root, ['status', '--porcelain=v1', '-uall', '--', ...uniquePaths]).stdout;
    if (dirty) throw new RuntimeError('rsi_dirty', `RSI target files have uncommitted changes: ${dirty}`);

    const originalHead = revParse(root, 'HEAD');
    if (!originalHead) throw new RuntimeError('rsi_unavailable', 'Graph source checkout has no Git HEAD');
    const originalBranch = checkedOutBranch(root);
    const branch = originalBranch?.startsWith('rsi/')
      ? originalBranch
      : `rsi/${slug(title)}-${id.slice(0, 8)}`;
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

      const validation = await this.validate({
        root,
        checks: normalized.checks ?? [],
        activate: normalized.activate === true,
      });
      const failed = validation.find(result => result.status === 'failed');
      if (failed) throw new RuntimeError('rsi_validation', `${failed.command} failed:\n${failed.output}`);

      // Stage only paths that exist now or were tracked before, so a delete of a
      // never-tracked file does not fail the whole change set.
      const tracked = new Set(git(root, ['ls-files', '--', ...uniquePaths]).stdout.split('\n').filter(Boolean));
      const stagePaths = uniquePaths.filter(path => tracked.has(path) || existsSync(join(root, path)));
      if (!stagePaths.length) throw new RuntimeError('rsi_no_change', 'RSI change set produced no file changes');
      const staged = git(root, ['add', '-A', '--', ...stagePaths]);
      if (staged.code !== 0) throw new RuntimeError('rsi_git', staged.stderr || 'Failed to stage RSI changes');
      const committed = git(root, ['commit', '--no-verify', '-m', `rsi: ${title}`, '--', ...stagePaths]);
      if (committed.code !== 0) throw new RuntimeError('rsi_git', committed.stderr || 'Failed to commit RSI changes');
      const commit = revParse(root, 'HEAD');
      if (!commit) throw new RuntimeError('rsi_git', 'RSI commit did not produce a HEAD');

      const restartRequired = normalized.activate === true;
      if (restartRequired) {
        await writeAtomic(this.restartPath(), `${JSON.stringify({
          id, root, branch, commit, requestedAt: Date.now(),
        }, null, 2)}\n`);
      }
      const diff = await diffFor(root, commit);
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
      if (createdBranch && originalBranch) {
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
