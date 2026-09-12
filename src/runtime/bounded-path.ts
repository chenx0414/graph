import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

const GIT_METADATA = '.git';

function outside(): never { throw new Error('Path is outside the workspace'); }

/**
 * Resolve a caller-supplied relative path under a trusted root.
 *
 * The boundary is enforced per path component at use time, not by comparing
 * strings once: no component may be a symbolic link, no path may touch Git
 * metadata, and every existing component must still canonicalize to itself.
 */
export async function resolveBounded(root: string, relative: string, mode: 'read' | 'write') {
  if (typeof relative !== 'string' || relative.length === 0 || relative.includes('\0')) throw new Error('A nonempty path is required');
  const target = resolve(root, relative);
  if (target !== root && !target.startsWith(`${root}${sep}`)) outside();
  if (target === root) return target;
  const parts = target.slice(root.length + 1).split(sep);
  let current = root;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index]!;
    if (!part || part === '.') continue;
    if (part === '..') outside();
    if (part === GIT_METADATA) throw new Error('Git metadata cannot be accessed through workspace tools');
    current = join(current, part);
    const last = index === parts.length - 1;
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (mode === 'read' || last) return target;
      try { await mkdir(current); }
      catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
      info = await lstat(current);
    }
    if (info.isSymbolicLink()) throw new Error(`Refusing to follow the symbolic link ${part}`);
    if (!last && !info.isDirectory()) throw new Error(`Not a directory: ${part}`);
    if (mode === 'write' && last && info.isFile() && info.nlink > 1) throw new Error('Refusing to overwrite a multiply-linked file');
    if (await realpath(current) !== current) throw new Error(`Path changed while resolving ${part}`);
  }
  return target;
}

async function openBounded(root: string, relative: string, mode: 'read' | 'write') {
  const target = await resolveBounded(root, relative, mode);
  if (target === root) throw new Error('A file path is required');
  const flags = mode === 'read'
    ? constants.O_RDONLY | constants.O_NOFOLLOW
    : constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW;
  let handle: FileHandle;
  try { handle = await open(target, flags, 0o644); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new Error('Refusing to follow a symbolic link');
    throw error;
  }
  try {
    if (await realpath(dirname(target)) !== dirname(target)) throw new Error('Path changed during open');
    const opened = await handle.stat();
    const current = await lstat(target).catch(() => undefined);
    if (!current || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Path changed during open');
    if (mode === 'write' && current.nlink > 1) throw new Error('Refusing to overwrite a multiply-linked file');
    return handle;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export async function readBounded(root: string, relative: string) {
  const handle = await openBounded(root, relative, 'read');
  try { return await handle.readFile({ encoding: 'utf8' }); }
  finally { await handle.close(); }
}

export async function writeBounded(root: string, relative: string, content: string) {
  const handle = await openBounded(root, relative, 'write');
  try { await handle.writeFile(content, 'utf8'); }
  finally { await handle.close(); }
}

export async function listBounded(root: string, relative: string) {
  const target = await resolveBounded(root, relative, 'read');
  const info = target === root ? undefined : await lstat(target);
  if (info && !info.isDirectory()) throw new Error('Not a directory');
  return readdir(target);
}
