import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

/**
 * The live daemon runs `node src/server/cli.ts`, and Node's TypeScript loader strips
 * types without transforming them. That loader refuses one very common TypeScript
 * spelling: the constructor parameter property
 *
 *     constructor(private readonly store: TaskStore) {}
 *
 * Vitest transpiles properly, so a module full of parameter properties passes every
 * unit test and then throws the moment the daemon imports it:
 *
 *     SyntaxError [ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX]:
 *       TypeScript parameter property is not supported in strip-only mode
 *
 * That happened to the whole v2 kernel: `kernel-store.ts`, `graph-runtime.ts`,
 * `module-runtime.ts`, `node-queue.ts`, `node-executor.ts`, `node-turn-driver.ts`,
 * `node-submit-bridge.ts`, `artifact-provenance.ts`, `rule-engine.ts` and
 * `resident-host.ts` all imported fine under Vitest and all failed under `node`. The
 * first time the live path touched them (`confirm` → `confirm-graph` → `kernel-store`)
 * the daemon died at import and 10 product tests failed with a message that pointed at
 * SQLite, not at the real cause.
 *
 * This guard catches the class instead of the instance: it rejects parameter properties
 * anywhere in `src/`, and separately proves the kernel modules actually load under the
 * strip-only loader the daemon uses. A module that cannot load in production is not
 * implemented, however green its unit tests are.
 */

// fileURLToPath, not URL.pathname: pathname is percent-encoded, and a checkout under a
// directory with a space in its name resolves to a `%20` path that no file has.
const ROOT = fileURLToPath(new URL('../..', import.meta.url));

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) sourceFiles(path, found);
    else if (path.endsWith('.ts')) found.push(path);
  }
  return found;
}

// A parameter property is `constructor(` ... `private/public/protected/readonly <name>:`.
// Matching the modifier directly after `(` or `,` inside a constructor signature keeps
// ordinary parameters and object-type members out.
const PARAMETER_PROPERTY = /constructor\s*\(([^)]*)\)/gs;

function parameterProperties(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(PARAMETER_PROPERTY)) {
    const params = match[1]!;
    // Split on top-level commas so `{ defaultRetries?: number } = {}` stays intact.
    let depth = 0;
    let current = '';
    const parts: string[] = [];
    for (const char of params) {
      if ('([{<'.includes(char)) depth += 1;
      if (')]}>'.includes(char)) depth -= 1;
      if (char === ',' && depth === 0) { parts.push(current); current = ''; continue; }
      current += char;
    }
    parts.push(current);
    for (const part of parts) {
      if (/^\s*(?:private|public|protected|readonly)\s+[A-Za-z_$]/.test(part)) found.push(part.trim());
      // `private readonly x` also matches the single-modifier case above; a two-modifier
      // spelling starts with `private`, so it is already covered.
    }
  }
  return found;
}

describe('the live runtime can actually load the source (§13.8)', () => {
  test('no source file uses a constructor parameter property', () => {
    const offenders: string[] = [];
    for (const path of sourceFiles(join(ROOT, 'src'))) {
      const source = readFileSync(path, 'utf8');
      for (const property of parameterProperties(source)) {
        offenders.push(`${relative(ROOT, path)}: ${property}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('every source module parses under the strip-only loader the daemon uses', () => {
    // One process per module would be hundreds of spawns. Batch them: a single process
    // imports each module in turn and reports the ones that failed to PARSE.
    const modules = sourceFiles(join(ROOT, 'src')).map(path => relative(ROOT, path));
    const script = `
      const modules = ${JSON.stringify(modules)};
      const failed = [];
      for (const m of modules) {
        try { await import('./' + m); } catch (e) {
          const message = String(e && e.message || e);
          if (/strip-only mode|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|SyntaxError/.test(message)) failed.push(m + ': ' + message.split('\\n')[0]);
        }
      }
      if (failed.length) { console.error(JSON.stringify(failed)); process.exit(1); }
      console.error('[]');
    `;
    let failed: string[] = [];
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 });
    } catch (error) {
      const stderr = (error as { stderr?: Buffer }).stderr?.toString() ?? String(error);
      try { failed = JSON.parse(stderr.trim().split('\n').pop()!) as string[]; }
      catch { failed = [stderr.split('\n')[0]!]; }
    }
    expect(failed).toEqual([]);
  }, 180_000);
});
