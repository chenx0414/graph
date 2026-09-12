import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../src/git/git.ts';
import { RuntimeError } from '../../src/core/types.ts';

/** Default input project for G17. Overridable; tests never write back to this tree. */
export function mediaBookmarksSource() {
  const override = process.env.GRAPH_MEDIABOOKMARKS_ROOT?.trim();
  return override && override.length > 0 ? override : join(process.cwd(), '..', '12-MediaBookmarks');
}

/** Git clone of tracked files only: no node_modules, output, raw, .env, or browser profile. */
export function cloneMediaBookmarks(dest: string, source = mediaBookmarksSource()) {
  if (!existsSync(join(source, '.git'))) throw new RuntimeError('invalid_input', `MediaBookmarks git source is missing: ${source}`);
  const result = git(source, ['clone', '--no-hardlinks', '--single-branch', source, dest]);
  if (result.code !== 0) throw new Error(result.stderr || 'git clone failed');
  for (const extra of ['node_modules', 'output', 'raw', '.env', '.env.bm', '.browser-profile', '.venv-py', 'tools/MediaCrawler']) {
    if (existsSync(join(dest, extra))) throw new Error(`clone copied excluded path ${extra}`);
  }
  return dest;
}
