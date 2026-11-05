/**
 * The filesystem half of crash recovery: find the system crash report that
 * belongs to a run, and write the record the app reads back on the next start.
 *
 * `crash.ts` decides what the facts mean; this module only reads and writes.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { crashReason, parseCrashReport, selectCrashReport, type CrashRecord, type CrashReportFacts } from './crash.ts';

/**
 * Where macOS keeps the reports.
 *
 * The account's home, not `HOME`: a launch that overrides `HOME` (the isolated
 * instance an end-to-end test starts) still belongs to the same user, and the
 * report the system wrote for it is in the account's directory. `GRAPH_CRASH_
 * REPORT_DIR` exists for a machine that keeps them elsewhere.
 */
export function diagnosticReportsDir(home?: string): string {
  if (home) return join(home, 'Library/Logs/DiagnosticReports');
  const override = process.env.GRAPH_CRASH_REPORT_DIR?.trim();
  if (override) return override;
  try {
    return join(userInfo().homedir, 'Library/Logs/DiagnosticReports');
  } catch {
    return join(process.env.HOME ?? '', 'Library/Logs/DiagnosticReports');
  }
}

/**
 * The report of this exact run, if macOS wrote one.
 *
 * A crash report appears seconds after the process dies, so the search is
 * bounded by file mtime before anything is parsed: a machine with hundreds of
 * old reports must not slow down every app launch.
 */
export function findCrashReport(input: {
  pid: number;
  bootedAt: number;
  at: number;
  dir?: string;
  readFile?: (path: string) => string;
  list?: (dir: string) => string[];
  mtime?: (path: string) => number;
}): CrashReportFacts | null {
  const dir = input.dir ?? diagnosticReportsDir();
  const readFile = input.readFile ?? (path => readFileSync(path, 'utf8'));
  const list = input.list ?? (path => readdirSync(path));
  const mtime = input.mtime ?? (path => statSync(path).mtimeMs);
  let names: string[];
  try { names = list(dir); } catch { return null; }
  const from = input.bootedAt - 60_000;
  const until = input.at + 60_000;
  const reports: CrashReportFacts[] = [];
  for (const name of names) {
    if (!name.endsWith('.ips')) continue;
    const path = join(dir, name);
    let modified: number;
    try { modified = mtime(path); } catch { continue; }
    if (modified < from || modified > until) continue;
    let facts: CrashReportFacts | null = null;
    try { facts = parseCrashReport(readFile(path), path); } catch { continue; }
    if (facts) reports.push(facts);
  }
  return selectCrashReport(reports, { pid: input.pid, bootedAt: input.bootedAt, at: input.at });
}

/** Write the record atomically: a reader sees the old file or the new one. */
export function writeCrashRecord(path: string, record: CrashRecord): CrashRecord {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
  return record;
}

/**
 * Build the record for a run that did not exit normally.
 *
 * `source` says who saw the exit: `keeper` when a parent process caught the
 * exit status, `marker` when only the run marker survived. Both the reason text
 * and the `source` field come from what could actually be observed - a record
 * whose reason names no source would be the "unknown reason" this feature must
 * not produce.
 */
export function buildCrashRecord(input: {
  /** The marker the dead run left behind, or the keeper's own knowledge of it. */
  previous: { pid: number; bootedAt: number; conversationId?: string | null };
  exitCode: number | null;
  signal: string | null;
  source: 'keeper' | 'marker';
  now?: number;
  home?: string;
  dir?: string;
}): CrashRecord {
  const now = input.now ?? Date.now();
  const report = findCrashReport({
    pid: input.previous.pid,
    bootedAt: input.previous.bootedAt,
    at: now,
    dir: input.dir ?? diagnosticReportsDir(input.home),
  });
  return {
    version: 1,
    at: now,
    pid: input.previous.pid,
    bootedAt: input.previous.bootedAt,
    conversationId: input.previous.conversationId ?? null,
    exitCode: input.exitCode,
    signal: input.signal,
    reason: crashReason({
      bootedAt: input.previous.bootedAt, exitCode: input.exitCode, signal: input.signal, report, source: input.source,
    }),
    source: report ? 'ips' : input.source,
    ...(report ? { ips: report.path } : {}),
  };
}
