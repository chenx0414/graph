import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


export function findGraphd(starts: string[]): string {
  const fromEnv = process.env.GRAPH_DAEMON_BIN;
  if (fromEnv) {
    if (!existsSync(fromEnv)) throw new Error(`GRAPH_DAEMON_BIN does not exist: ${fromEnv}`);
    return resolve(fromEnv);
  }
  const seen = new Set<string>();
  for (const start of starts) {
    let dir = resolve(start);
    for (let depth = 0; depth < 12; depth += 1) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const candidate = join(dir, 'dist', process.platform === 'win32' ? 'graphd.exe' : 'graphd');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('dist/graphd is missing. Run `npm run build:backend` to build it.');
}

export function graphdSearchStarts(): string[] {
  return [process.cwd(), dirname(fileURLToPath(import.meta.url))];
}
