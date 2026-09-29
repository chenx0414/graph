// Read-only diagnostic: source-file scale and module-directory distribution.
//
// It walks a source tree (by default this repository's `src/`) and, for every
// immediate module directory (`src/core`, `src/runtime`, `src/web`, ...), reports
// the number of source files, their total lines and bytes. It also prints the
// overall total, a per-extension breakdown and the largest files.
//
// Nothing is written and nothing beyond the Node standard library is used.
//
// Usage:
//   node scripts/diag-b.mjs                 # human summary of this repo's src/
//   node scripts/diag-b.mjs --json          # same numbers as JSON on stdout
//   node scripts/diag-b.mjs --target <dir>  # point it at another source tree
//
// Only text source extensions are counted; generated data (`.json` snapshots),
// images and archives are reported under `skipped`, so they never inflate the
// file, line or byte totals.

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts',
  '.js', '.mjs', '.cjs', '.jsx',
  '.css', '.scss', '.html',
]);

const LARGEST_COUNT = 10;

const scriptDirectory = resolve(fileURLToPath(import.meta.url), '..');
const repoRoot = resolve(scriptDirectory, '..');

function usage() {
  return [
    'Summarize source-file scale per module directory (read-only).',
    '',
    'Usage: node scripts/diag-b.mjs [--json] [--target <dir>]',
    '',
    '  --json           print the summary as JSON instead of a table',
    '  --target <dir>   source tree to inspect (default: <repo>/src)',
    '  --help           print this message',
  ].join('\n');
}

function parseArguments(argv) {
  let asJson = false;
  let target;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') {
      asJson = true;
    } else if (argument === '--help' || argument === '-h') {
      console.log(usage());
      process.exit(0);
    } else if (argument === '--target') {
      target = argv[index + 1];
      index += 1;
      if (!target) throw new Error('--target requires a directory');
    } else {
      throw new Error(`unknown argument: ${argument}`);
    }
  }

  return { asJson, target: resolve(target ?? join(repoRoot, 'src')) };
}

/** Lines as an editor counts them: a trailing newline does not add an empty line. */
function countLines(text) {
  if (text === '') return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

async function listChildren(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  const directories = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) directories.push(path);
    else if (entry.isFile()) files.push(path);
  }
  return { files, directories };
}

/** Every regular file under `directory`, recursively. */
async function listFiles(directory) {
  const files = [];
  const stack = [directory];
  while (stack.length) {
    const current = stack.pop();
    const { files: directFiles, directories } = await listChildren(current);
    files.push(...directFiles);
    stack.push(...directories);
  }
  return files;
}

/** Walk the target once and print (or emit) scale by module, extension and largest file. */
async function main() {
  const { asJson, target } = parseArguments(process.argv.slice(2));
  const prefix = basename(target);

  // One walk produces every number: each source file lands in exactly one
  // module bucket, plus the shared extension and largest-file views.
  const buckets = new Map();
  const extensionBuckets = new Map();
  const largest = [];
  let skipped = 0;

  const moduleOf = file => {
    const rel = relative(target, file);
    const slash = rel.indexOf('/');
    return slash === -1 ? prefix : `${prefix}/${rel.slice(0, slash)}`;
  };

  for (const file of await listFiles(target)) {
    const extension = extname(file).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(extension)) {
      skipped += 1;
      continue;
    }
    const text = await readFile(file, 'utf8');
    const lines = countLines(text);
    const bytes = Buffer.byteLength(text);

    const name = moduleOf(file);
    const module = buckets.get(name) ?? { name, files: 0, lines: 0, bytes: 0 };
    module.files += 1;
    module.lines += lines;
    module.bytes += bytes;
    buckets.set(name, module);

    const ext = extensionBuckets.get(extension) ?? { extension, files: 0, lines: 0, bytes: 0 };
    ext.files += 1;
    ext.lines += lines;
    ext.bytes += bytes;
    extensionBuckets.set(extension, ext);

    largest.push({ path: relative(repoRoot, file), lines, bytes });
  }

  const modules = [...buckets.values()].sort((left, right) => left.name.localeCompare(right.name));
  const extensions = [...extensionBuckets.values()].sort((left, right) => left.extension.localeCompare(right.extension));
  largest.sort((left, right) => right.lines - left.lines || left.path.localeCompare(right.path));

  const total = modules.reduce(
    (sum, module) => ({ files: sum.files + module.files, lines: sum.lines + module.lines, bytes: sum.bytes + module.bytes }),
    { files: 0, lines: 0, bytes: 0 },
  );

  const report = {
    target: relative(repoRoot, target) || '.',
    modules,
    extensions,
    largest: largest.slice(0, LARGEST_COUNT),
    total,
    skipped,
  };

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const number = value => value.toLocaleString('en-US');
  const average = module => (module.files ? (module.lines / module.files).toFixed(1) : '0.0');
  const nameWidth = Math.max('Module'.length, ...modules.map(module => module.name.length));

  console.log(`Source scale per module (${report.target})`);
  console.log('');
  console.log(`${'Module'.padEnd(nameWidth)}  ${'Files'.padStart(7)}  ${'Lines'.padStart(10)}  ${'Bytes'.padStart(12)}  ${'Avg lines'.padStart(9)}`);
  console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(7)}  ${'-'.repeat(10)}  ${'-'.repeat(12)}  ${'-'.repeat(9)}`);
  for (const module of modules) {
    console.log(`${module.name.padEnd(nameWidth)}  ${number(module.files).padStart(7)}  ${number(module.lines).padStart(10)}  ${number(module.bytes).padStart(12)}  ${average(module).padStart(9)}`);
  }
  console.log(`${'-'.repeat(nameWidth)}  ${'-'.repeat(7)}  ${'-'.repeat(10)}  ${'-'.repeat(12)}  ${'-'.repeat(9)}`);
  console.log(`${'TOTAL'.padEnd(nameWidth)}  ${number(total.files).padStart(7)}  ${number(total.lines).padStart(10)}  ${number(total.bytes).padStart(12)}  ${(total.files ? total.lines / total.files : 0).toFixed(1).padStart(9)}`);
  if (skipped) console.log(`\n${number(skipped)} non-source file(s) skipped.`);

  console.log('\nBy extension');
  for (const extension of extensions) {
    console.log(`  ${extension.extension.padEnd(7)} ${number(extension.files).padStart(5)} files  ${number(extension.lines).padStart(9)} lines`);
  }

  console.log(`\nLargest files (top ${Math.min(LARGEST_COUNT, largest.length)})`);
  largest.slice(0, LARGEST_COUNT).forEach((file, index) => {
    console.log(`  ${String(index + 1).padStart(2)}. ${number(file.lines).padStart(8)} lines  ${file.path}`);
  });
}

try {
  await main();
} catch (error) {
  console.error(`diag-b: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
