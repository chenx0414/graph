import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

export interface GitIdentity {
  name: string;
  email: string;
}

function runGit(cwd: string, args: string[], input?: string, identity?: GitIdentity) {
  const result = spawnSync('git', [...flags, ...args], {
    cwd, encoding: 'utf8', timeout: 15_000, stdio: ['pipe', 'pipe', 'pipe'], ...(input !== undefined ? { input } : {}),
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: identity?.name ?? 'Graph', GIT_AUTHOR_EMAIL: identity?.email ?? 'graph@local',
      GIT_COMMITTER_NAME: identity?.name ?? 'Graph', GIT_COMMITTER_EMAIL: identity?.email ?? 'graph@local',
      GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', GIT_EDITOR: 'true', EDITOR: 'true',
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  if (result.error) return { code: 1, stdout: '', stderr: result.error.message };
  return { code: result.status ?? 1, stdout: result.stdout ?? '', stderr: (result.stderr ?? '').trim() };
}

export function git(cwd: string, args: string[], input?: string, identity?: GitIdentity) {
  const result = runGit(cwd, args, input, identity);
  return { ...result, stdout: result.stdout.trim() };
}

/** Untrimmed variant: porcelain parsing must not lose the leading status space. */
function gitRaw(cwd: string, args: string[], input?: string) {
  return runGit(cwd, args, input);
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
  // Documentation examples stay visible even though every other env variant
  // is ignored; order matters, negations must follow the exclude.
  '!.env.example', '!.env.sample', '!.env.template', '!.env.dist', '!.env.defaults',
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

/** Credential/documentation policy: every `.env` variant is excluded except an
 * explicit documentation whitelist, so a new variant (`.env.production`) can
 * never silently enter a baseline. */
const ENV_DOC_WHITELIST = new Set(['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.defaults']);
function envLike(name: string) {
  return name === '.env' || name.startsWith('.env.');
}

/** Sensitive or host-managed path that must never enter a baseline commit. */
export function baselineExcluded(relPath: string, stateRel: string | null) {
  const normalized = relPath.replace(/\\/g, '/');
  if (stateRel && (normalized === stateRel || normalized.startsWith(`${stateRel}/`))) return true;
  const segments = normalized.split('/');
  if (segments.some(segment => ['node_modules', 'dist', 'coverage', '.stage', '.git'].includes(segment))) return true;
  const name = segments[segments.length - 1] ?? '';
  if (name === 'graph.config.json' || name === 'secrets.json' || name === '.DS_Store') return true;
  if (/\.sqlite(-wal|-shm)?$/.test(name)) return true;
  if (envLike(name) && !ENV_DOC_WHITELIST.has(name)) return true;
  if (/\.(pem|key|p12|pfx)$/.test(name) || name === '.netrc' || name === '.git-credentials') return true;
  return false;
}

export interface ProjectPathEntry { path: string; kind: 'file' | 'directory' }

/** Visible project paths for chat references. The same exclusion policy as a
 * local baseline applies, so credentials, Git metadata and generated trees
 * never enter the suggestion list. */
export function projectPathEntries(root: string, options: { stateDir?: string; query?: string; limit?: number } = {}): ProjectPathEntry[] {
  const projectRoot = real(root);
  const repo = detectRepo(projectRoot);
  const files = new Set<string>();
  const directories = new Set<string>();
  const addFile = (path: string) => {
    const normalized = path.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized) return;
    files.add(normalized);
    const parts = normalized.split('/');
    for (let index = 1; index < parts.length; index += 1) directories.add(parts.slice(0, index).join('/'));
  };
  if (repo) {
    const scope = relative(repo, projectRoot).split(sep).join('/').replace(/^\.$/, '');
    const prefix = scope ? `${scope}/` : '';
    const stateRel = options.stateDir && pathInside(repo, options.stateDir)
      ? relative(repo, real(options.stateDir)).split(sep).join('/')
      : null;
    const raw = gitRaw(repo, ['ls-files', '-co', '--exclude-standard', '-z', '--', scope || '.']).stdout;
    for (const item of raw.split('\0')) {
      const repoPath = item.replace(/\\/g, '/');
      if (!repoPath || !inScope(repoPath, scope || '.') || baselineExcluded(repoPath, stateRel)) continue;
      addFile(prefix && repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : repoPath);
    }
  } else {
    const stateRel = options.stateDir && pathInside(projectRoot, options.stateDir)
      ? relative(projectRoot, real(options.stateDir)).split(sep).join('/')
      : null;
    let count = 0;
    const walk = (dir: string, base: string) => {
      if (count > 5_000) return;
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const path = base ? `${base}/${entry.name}` : entry.name;
        if (baselineExcluded(path, stateRel)) continue;
        if (entry.isDirectory()) {
          directories.add(path);
          walk(join(dir, entry.name), path);
          continue;
        }
        if (!entry.isFile()) continue;
        count += 1;
        addFile(path);
      }
    };
    walk(projectRoot, '');
  }
  const query = (options.query ?? '').trim().replace(/\\/g, '/').toLowerCase();
  const entries: ProjectPathEntry[] = [
    ...[...directories].map(path => ({ path, kind: 'directory' as const })),
    ...[...files].map(path => ({ path, kind: 'file' as const })),
  ].filter(entry => !query || entry.path.toLowerCase().includes(query));
  entries.sort((left, right) => {
    const score = (entry: ProjectPathEntry) => {
      const lower = entry.path.toLowerCase();
      const base = lower.split('/').at(-1) ?? lower;
      return query ? (lower.startsWith(query) ? 0 : base.startsWith(query) ? 1 : 2) : 0;
    };
    return score(left) - score(right) || left.path.length - right.path.length || left.path.localeCompare(right.path);
  });
  return entries.slice(0, Math.min(Math.max(options.limit ?? 80, 1), 200));
}

interface StatusRecord { code: string; path: string; origPath?: string }

/** Parse `git status --porcelain=v1 -z` into records (rename/copy carry the
 * original path in the following NUL field). */
function parseStatus(raw: string): StatusRecord[] {
  const fields = raw.split('\0');
  const records: StatusRecord[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (!field) continue;
    const code = field.slice(0, 2);
    const path = field.length > 3 ? field.slice(3) : '';
    if (code[0] === 'R' || code[0] === 'C') {
      const original = fields[index + 1] ?? '';
      index += 1;
      records.push({ code, path, ...(original ? { origPath: original } : {}) });
    } else if (path) records.push({ code, path });
  }
  return records;
}

function scopeOf(options: { subdir?: string }) {
  return options.subdir && options.subdir !== '' ? options.subdir : '.';
}

function stateRelOf(repo: string, options: { stateDir?: string }) {
  return options.stateDir && pathInside(repo, options.stateDir)
    ? relative(repo, real(options.stateDir)).split(sep).join('/')
    : null;
}

function inScope(path: string, scope: string) {
  return scope === '.' || path === scope || path.startsWith(`${scope}/`);
}

/** Status entries inside the project scope after the credential/host policy. */
function scopedStatus(repo: string, options: { subdir?: string; stateDir?: string }) {
  const scope = scopeOf(options);
  const stateRel = stateRelOf(repo, options);
  const raw = gitRaw(repo, ['status', '--porcelain=v1', '-z', '-uall', '--', scope]).stdout;
  return parseStatus(raw).filter(record => {
    if (!inScope(record.path, scope)) return false;
    if (baselineExcluded(record.path, stateRel)) return false;
    if (record.origPath !== undefined && !inScope(record.origPath, scope)) return false;
    return true;
  });
}

/** Explicit candidate list for a scoped baseline: the range changes from the
 * parent tree (adds, modifications, deletions, renames), never the whole index
 * and never a sibling directory. */
export function baselineFiles(repo: string, options: { subdir?: string; stateDir?: string } = {}) {
  const paths = new Set<string>();
  for (const record of scopedStatus(repo, options)) {
    paths.add(record.path);
    if (record.origPath) paths.add(record.origPath);
  }
  return [...paths].sort();
}

/** Dirty entries that a scoped baseline cannot capture (sensitive excluded). */
export function scopedDirty(repo: string, options: { subdir?: string; stateDir?: string } = {}) {
  return scopedStatus(repo, options).map(record => `${record.code} ${record.path}${record.origPath ? ` <- ${record.origPath}` : ''}`);
}

/** Stable, content-aware fingerprint of the readiness-relevant repository
 * state. A recorded `ready` state is only a snapshot; every boundary re-checks
 * it, and crash recovery compares it before replaying a baseline. */
export function repoFingerprint(repo: string, options: { subdir?: string; stateDir?: string } = {}) {
  const records = scopedStatus(repo, options);
  const existing = records.map(record => record.path).filter(path => existsSync(join(repo, path)));
  const hashes = existing.length
    ? git(repo, ['hash-object', '--stdin-paths'], existing.join('\n')).stdout
    : '';
  const status = records.map(record => `${record.code} ${record.path}${record.origPath ? ` ${record.origPath}` : ''}`).join('\0');
  return createHash('sha256')
    .update(`head=${revParse(repo, 'HEAD') ?? ''}\nbranch=${checkedOutBranch(repo) ?? ''}\nstatus=${status}\nblobs=${hashes}`)
    .digest('hex');
}

/** Content fingerprint for a directory that is not (yet) a Git repository:
 * recovery must prove the selected files are unchanged, never null==null. */
export function directoryFingerprint(root: string, options: { stateDir?: string } = {}) {
  const stateRel = options.stateDir && pathInside(root, options.stateDir)
    ? relative(root, real(options.stateDir)).split(sep).join('/')
    : null;
  const hash = createHash('sha256');
  let count = 0;
  const walk = (dir: string, base: string) => {
    if (count > 5_000) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const rel = base ? `${base}/${entry.name}` : entry.name;
      if (baselineExcluded(rel, stateRel)) continue;
      if (entry.isDirectory()) { walk(join(dir, entry.name), rel); continue; }
      if (!entry.isFile()) continue;
      count += 1;
      hash.update(rel).update('\0');
      try { hash.update(readFileSync(join(dir, entry.name))); } catch { hash.update('unreadable'); }
      hash.update('\0');
    }
  };
  walk(root, '');
  return `dir:${count}:${hash.digest('hex')}`;
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
  const head = revParse(cwd, 'HEAD');
  const files = baselineFiles(cwd, options);
  if (!files.length) {
    // With a parent commit an empty change set means "nothing new to record":
    // never replace the parent tree with an empty tree, and never commit
    // whatever else is staged. Only a truly empty repository gets a root
    // commit built without touching the user index.
    if (head) return head;
    const emptyTree = git(cwd, ['hash-object', '-t', 'tree', '/dev/null']).stdout;
    const created = git(cwd, ['commit-tree', emptyTree, '-m', message]);
    if (created.code !== 0 || !created.stdout) throw new Error(created.stderr || 'Baseline commit failed');
    const update = git(cwd, ['update-ref', 'HEAD', created.stdout]);
    if (update.code !== 0) throw new Error(update.stderr || 'Baseline ref update failed');
    return created.stdout;
  }
  const list = join(dirname(join(cwd, '.graph-tmp')), `.graph-baseline-${process.pid}-${Date.now()}`);
  writeFileSync(list, `${files.join('\0')}\0`);
  try {
    // Stage only paths that still exist in the worktree; staged deletions are
    // already in the index and are committed through the pathspec commit below.
    const present = files.filter(file => existsSync(join(cwd, file)));
    if (present.length) {
      const added = git(cwd, ['add', '-A', `--pathspec-from-file=${list}`, '--pathspec-file-nul']);
      if (added.code !== 0) {
        // `git add -A` fails when the pathspec selects only removals; retry
        // with the existing paths only.
        const fallback = git(cwd, ['add', '--', ...present]);
        if (fallback.code !== 0) throw new Error(fallback.stderr || 'Baseline add failed');
      }
    }
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
  return parseStatus(gitRaw(cwd, ['status', '--porcelain=v1', '-z', '-uall', '--', scope]).stdout).filter(record => {
    const file = real(resolve(cwd, record.path));
    return !prefixes.some(prefix => file === prefix || file.startsWith(`${prefix}/`));
  }).map(record => `${record.code} ${record.path}`);
}

export function hostExcludePaths(root: string) {
  return HOST_EXCLUDES.filter(line => !line.startsWith('#') && !line.startsWith('!')).map(line => resolve(root, line.replace(/\/$/, '')));
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

export function commitAll(cwd: string, message: string, identity?: GitIdentity) {
  git(cwd, ['add', '-A'], undefined, identity);
  if (isClean(cwd)) return revParse(cwd, 'HEAD');
  const committed = git(cwd, ['commit', '--no-verify', '-m', message], undefined, identity);
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
