import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { gitRaw } from '../git/git.ts';

/**
 * How the checkout the app runs from compares to the development checkout of the same repository.
 *
 * "The app runs the code I am editing" is an assumption, not a fact: the daemon loads its source from
 * the RSI root, feature work lands in another checkout of the same repository, and nothing said whether
 * the two still agreed. Measured once: the deployed checkout was missing three tests the development
 * line had carried for a day, and a runtime file would have gone unnoticed the same way.
 *
 * The answer is the content of the two working trees as git sees them - one `git status` of each
 * worktree, read through the other checkout's index - so only tracked files are compared, and a read
 * never refreshes an index (that would be a write inside a status route).
 */
export interface DeployDrift {
  /** The development checkout this was compared against. */
  root: string;
  /** Tracked by both checkouts, different content. */
  files: string[];
  /** Tracked on the development line and absent here: this checkout is behind. */
  missing: string[];
  /** Tracked here and absent on the development line: the development line is behind. */
  extra: string[];
  /** The subset under `src/`, which is what actually changes what the app does. */
  runtimeFiles: string[];
  /** One line a reader can act on without reading the lists. */
  note: string;
}

/** Whatever else a caller needs, a comparison must not let git write an index. */
const READ_ONLY = { GIT_OPTIONAL_LOCKS: '0' };

function statusLine(line: string) {
  if (line.length < 4) return null;
  const status = line.slice(0, 2);
  const rest = line.slice(3);
  // A rename is reported as `old -> new`; the new path is the one that exists now.
  return { deleted: status.includes('D'), path: rest.includes(' -> ') ? rest.slice(rest.lastIndexOf(' -> ') + 4) : rest };
}

/**
 * Tracked paths of `workTree`, seen through `owner`'s index.
 *
 * Reading it this way is what makes the comparison cheap and exact: git compares the content itself, so
 * a stat mismatch cannot produce a false difference, and only files the owner tracks take part.
 */
function comparedPaths(owner: string, workTree: string) {
  const result = gitRaw(owner, ['--work-tree', workTree, 'status', '--porcelain', '--untracked-files=no'], undefined, READ_ONLY);
  if (result.code !== 0) return null;
  const deleted: string[] = [];
  const changed: string[] = [];
  for (const line of result.stdout.split('\n')) {
    const parsed = statusLine(line);
    if (!parsed) continue;
    (parsed.deleted ? deleted : changed).push(parsed.path);
  }
  return { deleted, changed };
}

/**
 * The origin a checkout publishes to, read from its own config.
 *
 * Reading the file rather than asking git matters here: this runs once per neighbouring directory, and a
 * git process per candidate is too slow to do inside a status route (a parent directory can hold
 * thousands of entries). The trade-off is that a remote defined through an `include` is not seen - a
 * checkout whose origin is only declared there is simply not recognised as a candidate.
 */
export function originUrl(root: string) {
  const pointer = join(root, '.git');
  if (!existsSync(pointer)) return '';
  let dir = pointer;
  try {
    if (!statSync(pointer).isDirectory()) {
      // A worktree or submodule checkout keeps a file pointing at the real git directory.
      const line = readFileSync(pointer, 'utf8').trim();
      if (!line.toLowerCase().startsWith('gitdir:')) return '';
      const target = line.slice('gitdir:'.length).trim();
      dir = isAbsolute(target) ? target : resolve(dirname(pointer), target);
    }
    // A worktree's own git directory holds per-worktree state only; the config, and therefore the
    // remote, lives in the common directory it points at. Missing this made a worktree checkout look
    // like it published nowhere, which is why the checkout the app runs from was reported as an
    // ordinary sibling-less directory instead of being compared with the line it came from.
    const common = join(dir, 'commondir');
    if (existsSync(common)) {
      const target = readFileSync(common, 'utf8').trim();
      if (target) dir = isAbsolute(target) ? target : resolve(dir, target);
    }
    const config = join(dir, 'config');
    if (!existsSync(config)) return '';
    const match = /\[remote "origin"\][^[]*?\n\s*url = (.+)/.exec(readFileSync(config, 'utf8'));
    return match?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

/** Whether two paths are checkouts of the same repository, going by the origin they publish to. */
export function sameOrigin(left: string, right: string) {
  const leftUrl = originUrl(left);
  return Boolean(leftUrl) && leftUrl === originUrl(right);
}

/**
 * Checkouts to compare `root` against: the configured one when it is named, otherwise the checkouts of
 * the same repository sitting beside it.
 *
 * The sibling rule is a rule, not a guess: a development checkout of this repository is normally a
 * sibling, and one that publishes elsewhere is a different project and is left alone. `root` itself is
 * never a candidate - comparing a checkout with itself would always report agreement and read as proof.
 */
export function developmentCandidates(root: string, env: Record<string, string | undefined> = process.env) {
  const configured = env.GRAPH_DEVELOPMENT_ROOT?.trim();
  if (configured) return [resolve(configured)];
  const self = resolve(root);
  const parent = dirname(self);
  const found: string[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(parent, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
      .map(entry => entry.name);
  } catch {
    return [];
  }
  const own = originUrl(self);
  if (!own) return [];
  // Only directories that hold a checkout, and only those publishing to the same origin: a parent
  // directory can hold thousands of unrelated directories (a temp directory does), and reading one
  // config file each keeps that affordable.
  for (const name of entries) {
    const candidate = resolve(parent, name);
    if (candidate === self) continue;
    if (originUrl(candidate) !== own) continue;
    found.push(candidate);
  }
  return found.sort();
}

export function deployDrift(deployedRoot: string, developmentRoot: string): DeployDrift {
  const here = comparedPaths(deployedRoot, developmentRoot);
  const there = comparedPaths(developmentRoot, deployedRoot);
  const files = new Set<string>();
  const missing = new Set<string>();
  const extra = new Set<string>();
  // Read through this checkout's index: a file it tracks but the development line does not have is
  // this checkout's own; one the development line tracks and this checkout lack is this checkout's gap.
  if (here) {
    for (const path of here.changed) files.add(path);
    for (const path of here.deleted) extra.add(path);
  }
  if (there) {
    for (const path of there.changed) files.add(path);
    for (const path of there.deleted) missing.add(path);
  }
  // A path present on one side only is missing there, not different; never both.
  for (const path of missing) { files.delete(path); extra.delete(path); }
  for (const path of extra) files.delete(path);
  const runtimeFiles = [...files, ...missing, ...extra].filter(path => path.startsWith('src/')).sort();
  const name = basename(resolve(developmentRoot)) || developmentRoot;
  const sample = [...files, ...missing, ...extra].sort().slice(0, 3).join('、');
  const note = files.size + missing.size + extra.size === 0
    ? `部署检出与开发线 ${name} 内容一致`
    : `部署检出与开发线 ${name} 不一致：${files.size} 个文件内容不同、${missing.size} 个开发线有而这里没有、${extra.size} 个这里有而开发线没有（其中 ${runtimeFiles.length} 个在 src/）：${sample}`;
  return {
    root: resolve(developmentRoot),
    files: [...files].sort(),
    missing: [...missing].sort(),
    extra: [...extra].sort(),
    runtimeFiles,
    note,
  };
}
