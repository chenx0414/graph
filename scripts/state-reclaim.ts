/**
 * Reclaim space from the Graph state database.
 *
 * Dry run by default; `--apply` also makes a backup first and vacuums afterwards.
 * It takes the same owner lock the daemon takes, so against a state directory a
 * running Graph owns it refuses instead of touching live data. The rules live in
 * src/core/state-retention.ts and are covered by tests/console/state-retention.test.ts.
 *
 * Usage:
 *   node scripts/state-reclaim.ts --state-dir <path> [--apply]
 *     [--keep-events 200] [--keep-capabilities 1] [--keep-handoffs 1] [--min-age-days 1]
 */
import { copyFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { acquireOwner } from '../src/core/owner.ts';
import { applyRetention, planRetention, type RetentionOptions } from '../src/core/state-retention.ts';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function number(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`);
  return value;
}

const megabytes = (bytes: number) => (bytes / 1048576).toFixed(1);

async function main(): Promise<number> {
  const stateDir = arg('state-dir');
  if (!stateDir) {
    process.stdout.write('usage: node scripts/state-reclaim.ts --state-dir <path> [--apply]\n');
    return 2;
  }
  const apply = process.argv.includes('--apply');
  const options: RetentionOptions = {
    now: Date.now(),
    keepEventsPerTask: number('keep-events', 200),
    keepCapabilitiesPerNode: number('keep-capabilities', 1),
    keepHandoffsPerOperation: number('keep-handoffs', 1),
    minAgeMs: number('min-age-days', 1) * 86_400_000,
  };
  const dbPath = join(stateDir, 'tasks.sqlite');
  // The daemon's own lock: if it refuses us, Graph is running and this state is off limits.
  let release: (() => void) | undefined;
  try {
    release = acquireOwner(join(stateDir, 'owner.sqlite'));
  } catch (error) {
    if ((error as { code?: string }).code === 'owner_busy') {
      process.stdout.write(`refused: another daemon owns ${stateDir}; close Graph before reclaiming\n`);
      return 3;
    }
    throw error;
  }
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath);
    const before = (await stat(dbPath)).size;
    const plan = planRetention(db, options);
    process.stdout.write(`state: ${dbPath}\nfile: ${megabytes(before)} MB\n`);
    process.stdout.write(`would delete: ${plan.events} events (${megabytes(plan.bytes)} MB of text), `
      + `${plan.capabilities} capability rows, ${plan.handoffs} handoff rows\n`);
    if (!apply) {
      process.stdout.write('dry run: nothing was changed (pass --apply to reclaim)\n');
      return 0;
    }
    const stamp = Math.floor(Date.now() / 1000);
    for (const suffix of ['', '-wal', '-shm']) {
      try { await copyFile(`${dbPath}${suffix}`, `${dbPath}.bak-${stamp}${suffix}`); } catch { /* the sidecar may not exist */ }
    }
    process.stdout.write(`backup: ${dbPath}.bak-${stamp}\n`);
    const applied = applyRetention(db, options);
    process.stdout.write(`deleted: ${applied.events} events, ${applied.capabilities} capability rows, ${applied.handoffs} handoff rows\n`);
    db.exec('VACUUM');
    process.stdout.write(`file after VACUUM: ${megabytes((await stat(dbPath)).size)} MB\n`);
    return 0;
  } finally {
    db?.close();
    release?.();
  }
}

process.exitCode = await main();
