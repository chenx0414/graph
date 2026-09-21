import { existsSync } from 'node:fs';
import { realpath, symlink } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * A Git work copy is created fresh for one Agent instance and stays
 * dependency-free on disk. The project's installed toolchain is linked in on
 * demand, so one install serves every copy: an Agent command resolves
 * `node_modules` exactly as it would in the project root (`node --run check`,
 * `node_modules/.bin/*`, a project test runner), and a confirmed program check
 * uses the same link.
 *
 * The link target lives outside the work copy, so the sandbox still needs a
 * read grant for it - the returned resolved path is that grant. The link itself
 * is host-managed: `node_modules` is excluded through the repository-local
 * ignore list Graph writes when it creates a work copy, so a copy's `git add -A`
 * and every baseline can never commit it or point the target branch at a
 * developer path.
 */
export async function linkProjectDependencies(workspace: string, candidate?: string): Promise<string | undefined> {
  const modules = candidate ? await realpath(candidate).catch(() => undefined) : undefined;
  if (!modules) return undefined;
  const link = join(workspace, 'node_modules');
  if (!existsSync(link)) {
    try { await symlink(modules, link, 'dir'); }
    catch { /* The command reports its own resolution failure. */ }
  }
  return modules;
}
