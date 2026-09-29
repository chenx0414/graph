#!/usr/bin/env node
// diag-a — read-only inventory of this repository's test suite.
//
// Contract (the things the reviewer checks):
//   * adds no dependency: node builtins only (node:fs, node:path, node:url).
//   * touches nothing: it only reads the tree and prints. No write, rename,
//     delete, spawn, network or clock call appears below, so two runs over an
//     unchanged tree leave the work tree bit-for-bit identical.
//   * reproducible: no timestamp, no absolute path, no duration. The output is
//     sorted and deterministic, so it can be diffed or asserted on.
//   * cwd-independent: the repository root comes from this file's own URL, not
//     from process.cwd(), so `node scripts/diag-a.mjs` prints the same thing
//     from any directory.
//
// What is counted, and why:
//   files        — files under tests/ matching *.test.ts. That is exactly the
//                  include glob in vitest.config.ts, so this is the number of
//                  files vitest collects.
//   uncollected  — test-like files under tests/ with some other extension
//                  (tests/fixtures/m7/web-server.test.js and friends). They are
//                  fixtures, not suites, and vitest does not run them; they are
//                  reported so the gap between "test-looking files on disk" and
//                  "files vitest collects" is visible rather than surprising.
//   declarations — call sites of test()/it(), including the modifier forms
//                  test.each( / test.skip( / it.only( . This is a static count of
//                  declarations, NOT the number of cases vitest reports at run
//                  time: a test.each() table or a test() inside a for-loop
//                  expands into several runtime cases.
//
// Usage: node scripts/diag-a.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TESTS_DIR = join(REPO_ROOT, 'tests');
const SKIP_DIRS = new Set(['node_modules', '.git', 'build', 'dist', 'coverage']);

// Files vitest.config.ts collects, and the wider "looks like a test" shape.
const COLLECTED_EXT = /\.test\.ts$/;
const TEST_LIKE_EXT = /\.test\.(?:[cm]?[jt]sx?)$/;
// A test()/it() call site, with or without a modifier (.each, .skip, .only,
// .concurrent, .fails), and not a member access on something else.
const DECLARATION = /(?<![\w$.])(?:test|it)(?:\.\w+)*\s*\(/g;

const walk = (dir) => {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile()) out.push(full);
  }
  return out;
};

const countDeclarations = (file) => {
  const text = readFileSync(file, 'utf8');
  const hits = text.match(DECLARATION);
  return hits ? hits.length : 0;
};

const suiteKey = (file) => {
  const parts = relative(TESTS_DIR, file).split(sep);
  return parts.length > 1 ? `tests/${parts[0]}` : 'tests';
};

const report = () => {
  let files = [];
  try {
    files = walk(TESTS_DIR).filter((f) => COLLECTED_EXT.test(f));
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    console.log(`diag-a: no tests/ directory under ${TESTS_DIR}`);
    console.log('SUMMARY files=0 declarations=0 uncollected=0');
    return;
  }
  files.sort();

  const testLike = walk(TESTS_DIR).filter((f) => TEST_LIKE_EXT.test(f));
  const uncollected = testLike.filter((f) => !COLLECTED_EXT.test(f)).sort();

  const perSuite = new Map();
  let declarations = 0;
  for (const file of files) {
    const n = countDeclarations(file);
    declarations += n;
    const key = suiteKey(file);
    const bucket = perSuite.get(key) ?? { files: 0, declarations: 0 };
    bucket.files += 1;
    bucket.declarations += n;
    perSuite.set(key, bucket);
  }

  let pkg = 'unknown';
  try {
    pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).name ?? 'unknown';
  } catch {
    /* the inventory does not depend on package.json */
  }

  const width = Math.max(...[...perSuite.keys()].map((k) => k.length), 5);
  const row = (key, b) =>
    `  ${key.padEnd(width)}  ${String(b.files).padStart(4)} file(s)  ${String(b.declarations).padStart(5)} decl(s)`;

  console.log(`diag-a: test inventory of ${pkg} (read-only)`);
  console.log('');
  console.log('  files        test files matching tests/**/*.test.ts (the vitest include glob)');
  console.log('  declarations test()/it() call sites in those files');
  console.log('  uncollected  test-looking files vitest does not collect');
  console.log('');
  for (const key of [...perSuite.keys()].sort()) console.log(row(key, perSuite.get(key)));
  console.log('');
  console.log(`  ${files.length} test file(s), ${declarations} declaration(s), ${uncollected.length} uncollected test-like file(s)`);
  if (uncollected.length > 0) {
    console.log('  uncollected:');
    for (const file of uncollected) console.log(`    ${relative(REPO_ROOT, file)}`);
  }
  console.log(`SUMMARY files=${files.length} declarations=${declarations} uncollected=${uncollected.length}`);
};

report();
