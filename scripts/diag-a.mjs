#!/usr/bin/env node
// diag-a: read-only repository diagnostic.
//
// Counts how much test surface this repository carries and prints one summary line.
//
// Definitions (deliberately narrow, so the number is explainable):
//   * test file   - a file under the repository whose name ends in `.test.<ext>` or
//                   `.spec.<ext>` (ext = js/mjs/cjs/jsx/ts/tsx). This matches how the
//                   repository's vitest config names its suites (`tests/**/*.test.ts`).
//   * test case   - a line inside such a file that begins, after optional indentation,
//                   with an `it`/`test` declaration, including chained modifiers such as
//                   `it.each(...)`, `test.skip(...)` or `test.todo(...)`.
//
// The script only reads files. It imports nothing outside Node's standard library, takes
// no arguments, writes no files and prints a single line so it can be piped or diffed.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const TEST_FILE = /\.(?:test|spec)\.(?:js|mjs|cjs|jsx|ts|tsx)$/;
const TEST_CASE = /^\s*(?:it|test)(?:\.\w+)*\s*[(`]/;
const SKIP_DIRS = new Set(['.git', 'node_modules']);

async function collectTestFiles(dir) {
  const found = [];
  const entries = await readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await collectTestFiles(path)));
    } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
      found.push(path);
    }
  }
  return found;
}

async function main() {
  const testFiles = await collectTestFiles(repoRoot);
  let testCases = 0;
  for (const file of testFiles) {
    const text = await readFile(file, 'utf8');
    for (const line of text.split('\n')) {
      if (TEST_CASE.test(line)) testCases += 1;
    }
  }
  console.log(`diag-a: ${testFiles.length} test files, ${testCases} test cases`);
}

await main();
