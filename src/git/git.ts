import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

function real(path: string) {
  try { return realpathSync(path); } catch { return resolve(path); }
}

const flags = [
  '-c', 'core.pager=cat',
  '-c', 'core.editor=true',
  '-c', 'sequence.editor=true',
  '-c', 'commit.gpgsign=false',
  '-c', 'tag.gpgsign=false',
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'advice.detachedHead=false',
];

export function git(cwd: string, args: string[]) {
  const result = spawnSync('git', [...flags, ...args], {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Graph', GIT_AUTHOR_EMAIL: 'graph@local',
      GIT_COMMITTER_NAME: 'Graph', GIT_COMMITTER_EMAIL: 'graph@local',
      GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', EDITOR: 'true',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (result.error) return { code: 1, stdout: '', stderr: result.error.message };
  return { code: result.status ?? 1, stdout: (result.stdout ?? '').trim(), stderr: (result.stderr ?? '').trim() };
}

export function hasHead(cwd: string) {
  return git(cwd, ['rev-parse', '--verify', '-q', 'HEAD']).code === 0;
}

export function headSha(cwd: string) {
  return revParse(cwd, 'HEAD');
}

/** Host-managed local excludes. `.git/info/exclude` is repository-local and is
 * never committed, so initializing a plain directory cannot alter user files. */
const HOST_EXCLUDES = [
  '# Graph host-managed excludes (local only)',
  '.env', '.env.*', 'secrets.json', '.DS_Store',
  'node_modules/', 'state/', 'dist/', 'coverage/',
  '.stage/', 'graph.config.json',
];

/** A linked worktree (and a submodule) has a `.git` *file*, so the exclude
 * file must be located through Git, not by assuming a directory layout. */
export function gitPaths(repo: string) {
  const dir = git(repo, ['rev-parse', '--absolute-git-dir']).stdout;
  const common = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']).stdout;
  return { gitDir: dir || undefined, commonDir: common || dir || undefined };
}

export function ensureHostExcludes(repo: string, extra: string[] = []) {
  const paths = gitPaths(repo);
  const base = paths.commonDir ?? paths.gitDir;
  if (!base) return;
  const dir = join(base, 'info');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'exclude');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split('\n'));
  const missing = [...HOST_EXCLUDES, ...extra].filter(line => !lines.has(line));
  if (missing.length) writeFileSync(file, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
}

/** Sensitive or host-managed path that must never enter a baseline commit.
 * `.env.example` and friends are documentation and stay eligible. */
export function baselineExcluded(relPath: string, stateRel: string | null) {
  const normalized = relPath.replace(/\\/g, '/');
  if (stateRel && (normalized === stateRel || normalized.startsWith(`${stateRel}/`))) return true;
  const segments = normalized.split('/');
  if (segments.some(segment => ['node_modules', 'dist', 'coverage', '.stage', '.git'].includes(segment))) return true;
  const name = segments[segments.length - 1] ?? '';
  if (name === 'graph.config.json' || name === 'secrets.json' || name === '.DS_Store') return true;
  if (/\.sqlite(-wal|-shm)?$/.test(name)) return true;
  if (name === '.env' || name === '.env.local' || /\.env\..*\.local$/.test(name)) return true;
  return false;
}

/** Explicit file list for a scoped baseline: cached plus untracked files inside
 * the project scope, with host-managed and sensitive paths removed. */
export function baselineFiles(repo: string, options: { subdir?: string; stateDir?: string } = {}) {
  const scope = options.subdir && options.subdir !== '' ? options.subdir : '.';
  const listed = git(repo, ['ls-files', '-z', '-c', '-o', '--exclude-standard', '--', scope]).stdout.split('\0').filter(Boolean);
  const stateRel = options.stateDir && pathInside(repo, options.stateDir)
    ? relative(repo, real(options.stateDir)).split(sep).join('/')
    : null;
  return [...new Set(listed)].filter(file => !baselineExcluded(file, stateRel));
}

/** Stable fingerprint of the readiness-relevant repository state. A recorded
 * `ready` state is only a snapshot; it must be re-checked at each boundary. */
export function repoFingerprint(repo: string, options: { subdir?: string; stateDir?: string } = {}) {
  const scope = options.subdir && options.subdir !== '' ? options.subdir : '.';
  const stateRel = options.stateDir && pathInside(repo, options.stateDir)
    ? relative(repo, real(options.stateDir)).split(sep).join('/')
    : null;
  const status = git(repo, ['status', '--porcelain=v1', '-z', '-uall', '--', scope]).stdout
    .split('\0').filter(Boolean)
    .filter(line => !baselineExcluded(stripStatusPath(line), stateRel))
    .join('\0');
  return createHash('sha256')
    .update(`head=${revParse(repo, 'HEAD') ?? ''}\nbranch=${checkedOutBranch(repo) ?? ''}\nstatus=${status}`)
    .digest('hex');
}

function stripStatusPath(line: string) {
  // Porcelain v1: XY<space>path (rename entries append NUL + target).
  return line.length > 3 ? line.slice(3).replace(/^"+|"+$/g, '') : line;
}

export function initRepo(root: string) {
  const result = git(root, ['init', '-b', 'main']);
  if (result.code !== 0) {
    // Older Git without `-b` falls back to the configured default branch.
    const fallback = git(root, ['init']);
    if (fallback.code !== 0) throw new Error(fallback.stderr || result.stderr || 'git init failed');
  }
  ensureHostExcludes(root);
}

/** Commit the current visible tree as a local baseline, excluding host-managed
 * sensitive/generated paths; an empty tree produces an empty commit. */
/** Commit a baseline of exactly the given paths, never the whole index and
 * never a path outside the project scope. Files already staged by the user
 * (for example a synthetic `.env`) stay staged and uncommitted. */
export function commitBaseline(cwd: string, message: string, options: { subdir?: string; stateDir?: string } = {}) {
  const stateRel = options.stateDir && pathInside(cwd, options.stateDir)
    ? relative(cwd, real(options.stateDir)).split(sep).join('/')
    : undefined;
  ensureHostExcludes(cwd, stateRel ? [`${stateRel}/`] : []);
  const files = baselineFiles(cwd, options);
  if (!files.length) {
    // An empty baseline must not fall back to committing whatever is staged.
    const emptyTree = git(cwd, ['hash-object', '-t', 'tree', '/dev/null']).stdout;
    const args = ['commit-tree', emptyTree, '-m', message];
    const head = revParse(cwd, 'HEAD');
    if (head) args.push('-p', head);
    const created = git(cwd, args);
    if (created.code !== 0 || !created.stdout) throw new Error(created.stderr || 'Baseline commit failed');
    const update = git(cwd, ['update-ref', 'HEAD', created.stdout]);
    if (update.code !== 0) throw new Error(update.stderr || 'Baseline ref update failed');
    return created.stdout;
  }
  const list = join(dirname(join(cwd, '.graph-tmp')), `.graph-baseline-${process.pid}-${Date.now()}`);
  writeFileSync(list, `${files.join('\0')}\0`);
  try {
    const added = git(cwd, ['add', `--pathspec-from-file=${list}`, '--pathspec-file-nul']);
    if (added.code !== 0) throw new Error(added.stderr || 'Baseline add failed');
    const committed = git(cwd, ['commit', '--no-verify', '-m', message, `--pathspec-from-file=${list}`, '--pathspec-file-nul']);
    if (committed.code !== 0) throw new Error(committed.stderr || 'Baseline commit failed');
    return revParse(cwd, 'HEAD')!;
  } finally {
    rmSync(list, { force: true });
  }
}

/** Porcelain status entries that are not host-excluded, with their kind. */
export function dirtyEntries(cwd: string, ignore: string[] = [], scope = '.') {
  const prefixes = ignore.map(real);
  return git(cwd, ['status', '--porcelain', '-uall', '--', scope]).stdout.split('\n').filter(Boolean).filter(line => {
    const file = real(resolve(cwd, stripStatusPath(line)));
    return !prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
  });
}

export function hostExcludePaths(root: string) {
  return HOST_EXCLUDES.filter(line => !line.startsWith('#')).map(line => resolve(root, line.replace(/\/$/, '')));
}

export function detectRepo(root: string) {
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0 || !top.stdout) return;
  return resolve(top.stdout);
}

export function revParse(cwd: string, ref: string) {
  const result = git(cwd, ['rev-parse', ref]);
  return result.code === 0 ? result.stdout : undefined;
}

export function checkedOutBranch(repo: string) {
  const head = git(repo, ['symbolic-ref', '--quiet', 'HEAD']);
  if (head.code !== 0) return;
  return head.stdout.replace(/^refs\/heads\//, '');
}

export function isClean(cwd: string, ignore: string[] = []) {
  const prefixes = ignore.map(real);
  return git(cwd, ['status', '--porcelain', '-u']).stdout.split('\n').filter(Boolean).every(line => {
    const file = real(resolve(cwd, line.slice(3).replace(/^"+|"+$/g, '')));
    return prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
  });
}

export function pathInside(root: string, path: string) {
  const a = real(root);
  const b = real(path);
  return b === a || b.startsWith(`${a}/`);
}

export function worktreeList(repo: string) {
  const result = git(repo, ['worktree', 'list', '--porcelain']);
  const trees: { path: string; branch?: string }[] = [];
  let current: { path: string; branch?: string } | undefined;
  for (const line of result.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) trees.push(current);
      current = { path: resolve(line.slice(9)) };
    } else if (line.startsWith('branch ') && current) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (current) trees.push(current);
  return trees;
}

export function ensureBranch(repo: string, name: string, startPoint: string) {
  if (revParse(repo, name)) return;
  const created = git(repo, ['branch', '--', name, startPoint]);
  if (created.code !== 0) throw new Error(created.stderr || `Failed to create branch ${name}`);
}

export function ensureWorktree(repo: string, path: string, branch: string, startPoint: string) {
  const resolved = resolve(path);
  const existing = worktreeList(repo).find(tree => tree.path === resolved);
  if (existing) return;
  if (existsSync(resolved)) throw new Error(`Worktree path already exists: ${resolved}`);
  mkdirSync(dirname(resolved), { recursive: true });
  ensureBranch(repo, branch, startPoint);
  const added = git(repo, ['worktree', 'add', resolved, branch]);
  if (added.code !== 0) throw new Error(added.stderr || `Failed to add worktree ${resolved}`);
}

export function commitAll(cwd: string, message: string) {
  git(cwd, ['add', '-A']);
  if (isClean(cwd)) return revParse(cwd, 'HEAD');
  const committed = git(cwd, ['commit', '--no-verify', '-m', message]);
  if (committed.code !== 0) throw new Error(committed.stderr || 'Commit failed');
  return revParse(cwd, 'HEAD');
}

export function mergeRef(cwd: string, ref: string) {
  const merged = git(cwd, ['merge', '--no-edit', '--no-verify', '--', ref]);
  if (merged.code === 0) return { ok: true as const, sha: revParse(cwd, 'HEAD')! };
  const conflicts = git(cwd, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
  git(cwd, ['merge', '--abort']);
  return { ok: false as const, conflicts };
}

export function updateRef(repo: string, ref: string, next: string, previous: string) {
  const updated = git(repo, ['update-ref', ref, next, previous]);
  if (updated.code !== 0) return { ok: false as const, stderr: updated.stderr };
  return { ok: true as const };
}

export function fastForwardCheckout(repo: string, sha: string) {
  const merged = git(repo, ['merge', '--ff-only', '--no-edit', sha]);
  if (merged.code !== 0) return { ok: false as const, stderr: merged.stderr };
  return { ok: true as const };
}

export function abortMerge(cwd: string) {
  if (git(cwd, ['rev-parse', '-q', '--verify', 'MERGE_HEAD']).code !== 0) return;
  git(cwd, ['merge', '--abort']);
}

export function resetHard(cwd: string, sha: string) {
  const reset = git(cwd, ['reset', '--hard', sha]);
  if (reset.code !== 0) throw new Error(reset.stderr || `Failed to reset ${cwd}`);
}
