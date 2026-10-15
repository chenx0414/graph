#!/usr/bin/env node
/**
 * HB-255 — the gate must not silently lose tests.
 *
 * `node --run check` runs the whole suite and only asserts that everything passed.
 * A commit that ships source with no tests therefore still goes green: on
 * 2026-09-27, Phase 5a (d53e1a6) added `graph-runtime.ts` and `subgraph.ts` with
 * zero coverage, and the suite quietly fell from 1622 to 1609 tests without a word.
 *
 * The suite count is a checked invariant, not a coincidence: this guard compares the
 * run against a committed baseline and fails when either the file count or the test
 * count drops. Growth is fine and moves the baseline up; an intentional reduction
 * needs GRAPH_UPDATE_BASELINE=1 and announces itself.
 *
 * The vitest run emits its machine-readable totals through the json reporter
 * alongside the normal output (see package.json `test:report`), so no second run is
 * needed.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = resolve(here, '../tests/suite-baseline.json');
const REPORT_PATH = resolve(here, '../tests/.suite-report.json');

/**
 * Compare the current run against the baseline.
 *
 * Returns { ok, write, message }: `ok` false means the gate must fail; `write` true
 * means the baseline should be updated to `current`.
 */
function compareBaseline(baseline, current, update = false) {
  const malformed = baseline !== null
    && (typeof baseline !== 'object'
      || !Number.isInteger(baseline.files) || baseline.files < 0
      || !Number.isInteger(baseline.tests) || baseline.tests < 0);
  if (malformed) {
    return { ok: false, write: false, message: `Suite baseline is malformed (${JSON.stringify(baseline)}); refusing to compare against it.` };
  }

  const now = `files ${current.files}, tests ${current.tests}`;

  if (!baseline) {
    return { ok: true, write: true, message: `No suite baseline yet; writing ${now}.` };
  }

  if (update) {
    const moved = current.files > baseline.files || current.tests > baseline.tests ? 'updated' : 'lowered';
    return { ok: true, write: true, message: `GRAPH_UPDATE_BASELINE=1: baseline ${moved} to ${now} (was files ${baseline.files}, tests ${baseline.tests}).` };
  }

  if (current.files < baseline.files || current.tests < baseline.tests) {
    const lost = [];
    if (current.files < baseline.files) lost.push(`${baseline.files - current.files} file(s)`);
    if (current.tests < baseline.tests) lost.push(`${baseline.tests - current.tests} test(s)`);
    return {
      ok: false,
      write: false,
      message: `The suite shrank by ${lost.join(' and ')}: baseline files ${baseline.files}, tests ${baseline.tests}; current files ${current.files}, tests ${current.tests}. `
        + 'A missing test file or a deleted suite is not a pass. Restore it, or set GRAPH_UPDATE_BASELINE=1 when the reduction is deliberate.',
    };
  }

  const grew = current.files > baseline.files || current.tests > baseline.tests;
  return {
    ok: true,
    write: grew,
    message: grew
      ? `Suite baseline increased to ${now} (was files ${baseline.files}, tests ${baseline.tests}).`
      : `Suite matches the baseline (${now}).`,
  };
}

/** Read the counts vitest wrote with its json reporter. */
function readRunReport(path = REPORT_PATH) {
  if (!existsSync(path)) {
    throw new Error(`No suite report at ${path}. The gate must run the suite with the json reporter (see package.json "test:report").`);
  }
  const report = JSON.parse(readFileSync(path, 'utf8'));
  return { files: Array.isArray(report.testResults) ? report.testResults.length : 0, tests: report.numTotalTests ?? 0 };
}

function main() {
  const current = readRunReport();
  const baseline = existsSync(BASELINE_PATH) ? JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) : null;
  const result = compareBaseline(baseline, current, process.env.GRAPH_UPDATE_BASELINE === '1');
  if (result.write) {
    mkdirSync(dirname(BASELINE_PATH), { recursive: true });
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ ...current, updatedAt: new Date().toISOString() }, null, 2)}\n`);
  }
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
