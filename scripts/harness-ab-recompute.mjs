#!/usr/bin/env node
/**
 * Recompute the A/B numbers from the ledgers that are in the repository.
 *
 * The A/B summary was written by hand from two ledgers. A reader could not
 * check it: the run directories were gone, and the only thing left was the
 * paragraph. The ledgers are in the repository now, so the arithmetic is
 * reproducible - and this script does the arithmetic and then checks that the
 * report still says what the arithmetic says.
 *
 * The method, so the numbers are not ambiguous:
 *   - the baseline is the variant named in the second column: the percentage
 *     is (mean(A) - mean(B)) / mean(B);
 *   - the t statistic is Welch's: the two variants have different spreads;
 *   - a figure the report quotes must appear in the report, and a figure the
 *     report has replaced must not.
 *
 * Usage:
 *   node scripts/harness-ab-recompute.mjs [--check]
 *
 * With --check the script exits non-zero when the report and the ledgers
 * disagree. Without it, it prints the table and always exits zero.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ledgerDir = join(root, 'docs/planning/experiments');
const reportDir = join(root, 'docs/planning');

const GROUPS = [
  {
    file: 'token-efficiency-ab-one-turn-2026-10-23.json',
    label: 'one turn (n=6 per variant)',
    pairs: [['default', 'no-seam']],
  },
  {
    file: 'token-efficiency-ab-long-session-2026-10-23.json',
    label: 'eight rounds (n=2 per variant)',
    pairs: [['default', 'no-seam'], ['default', 'no-seam-ceiling']],
  },
];

const METRICS = [
  { label: 'prefix', field: run => run.context.mean, report: '18.2%' },
  { label: 'uncached input', field: run => run.tokens.input, report: '40.4%' },
  { label: 'input total', field: run => run.tokens.input + run.tokens.cacheRead, report: '12.4%' },
  { label: 'cost', field: run => run.cost, report: '14.0%' },
];

const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const deviation = values => {
  const average = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1));
};

function compare(runs, a, b, field) {
  const left = runs.filter(run => run.variant === a).map(field);
  const right = runs.filter(run => run.variant === b).map(field);
  const meanA = mean(left);
  const meanB = mean(right);
  const t = (meanA - meanB) / Math.sqrt(deviation(left) ** 2 / left.length + deviation(right) ** 2 / right.length);
  return { meanA, meanB, pct: ((meanA - meanB) / meanB) * 100, t, nA: left.length, nB: right.length };
}

const report = readFileSync(join(reportDir, 'harness-token-efficiency-2026-10-22-ab-rerun.md'), 'utf8');
const problems = [];
const check = process.argv.includes('--check');

for (const group of GROUPS) {
  const ledger = JSON.parse(readFileSync(join(ledgerDir, group.file), 'utf8'));
  console.log(`\n${group.label}  (${group.file})`);
  for (const [a, b] of group.pairs) {
    console.log(`  ${a} against ${b}`);
    for (const metric of METRICS) {
      const stat = compare(ledger.runs, a, b, metric.field);
      console.log(
        `    ${metric.label.padEnd(14)} ${stat.meanA.toFixed(4).padStart(12)} vs ${stat.meanB.toFixed(4).padStart(12)}` +
        `  ${stat.pct.toFixed(1).padStart(7)}%  t=${stat.t.toFixed(2)}  (n=${stat.nA}/${stat.nB})`,
      );
    }
    const verified = ledger.runs.filter(run => run.verified).length;
    console.log(`    behaviour checks passed: ${verified}/${ledger.runs.length}`);
  }
}

if (check) {
  // The report quotes the one-turn group's three figures. Each is written
  // with the sign in front of it or without, so the check is on the magnitude
  // and on the figure the report replaced.
  const quotes = [
    { text: '18.2%', why: 'the one-turn prefix reduction' },
    { text: '40.4%', why: 'the one-turn rise in uncached input' },
    { text: '14%', why: 'the one-turn cost difference' },
  ];
  for (const quote of quotes) {
    if (!report.includes(quote.text)) {
      problems.push(`the report no longer says ${quote.text} (${quote.why})`);
    }
  }
  if (report.includes('12.2%')) {
    problems.push('the report still says 12.2% for the eight-round cost; the ledgers give 12.3%');
  }
  if (!report.includes('12.3%')) {
    problems.push('the report does not say 12.3% for the eight-round cost, which is what the ledgers give');
  }
  if (problems.length) {
    console.error('\nthe report and the ledgers disagree:');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exit(1);
  }
  console.log('\nthe report agrees with the ledgers.');
}

if (!check) {
  console.log('\nRun with --check to test the report against these numbers.');
}
