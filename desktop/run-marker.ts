/**
 * This run's identity on disk, and the record of the run before it.
 *
 * Everything here runs before `app.whenReady()` on purpose: a run marker that
 * is written after the window is up would miss exactly the crashes this
 * feature exists for - the ones that kill the process during start-up.
 *
 * Semantics, in one place: the marker is present while a run is alive and is
 * deleted by a normal quit, so a marker found at start-up belongs to a run that
 * died. `crash.ts` decides whether the run it names is really gone; this module
 * only claims the file and hands the previous run's record to the app.
 */
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';
import { crashMarker, crashRecordPath, processAlive, runMarkerPath, type CrashRecord } from './crash.ts';
import { buildCrashRecord, writeCrashRecord } from './crash-record.ts';

const readJsonFile = (path: string): unknown => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

export interface RunState {
  /** The marker this run wrote; `conversationId` follows the user's navigation. */
  marker: { version: 1; pid: number; bootedAt: number; conversationId: string | null; electron?: string; appVersion?: string };
  /** The marker of the run before this one, when that run never said goodbye. */
  previousRun: ReturnType<typeof crashMarker>;
  /** What the app shows about that run, if it found one. */
  lastCrash: CrashRecord | null;
  markerPath: string;
  recordPath: string;
  rememberConversation(conversationId: string | null): void;
  removeMarker(): void;
}

export function beginRun(input: {
  userData: string;
  pid: number;
  bootedAt: number;
  conversationId?: string | null;
  electron?: string;
  appVersion?: string;
  alive?: (pid: number) => boolean;
}): RunState {
  const alive = input.alive ?? processAlive;
  const markerPath = runMarkerPath(input.userData);
  const recordPath = crashRecordPath(input.userData);
  let marker = {
    version: 1 as const,
    pid: input.pid,
    bootedAt: input.bootedAt,
    conversationId: input.conversationId ?? null,
    ...(input.electron ? { electron: input.electron } : {}),
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
  };

  const writeBody = (value: unknown) => {
    mkdirSync(dirname(markerPath), { recursive: true });
    const temp = `${markerPath}.${input.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, markerPath);
  };

  /** `O_EXCL` is what makes "one run owns this marker" true under a race. */
  function claim(): boolean {
    mkdirSync(dirname(markerPath), { recursive: true });
    try {
      const fd = openSync(markerPath, 'wx', 0o600);
      try { writeSync(fd, `${JSON.stringify(marker, null, 2)}\n`); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      // A concurrent instance for this userData must not take a live run's
      // marker. Only a marker whose pid is gone may be replaced, and the
      // replacement is a rename, so a reader never sees half a file.
      const owner = Number((readJsonFile(markerPath) as { pid?: unknown } | undefined)?.pid);
      if (owner > 0 && owner !== input.pid && alive(owner)) return false;
      writeBody(marker);
      return true;
    }
  }

  const previousRun = crashMarker({
    marker: readJsonFile(markerPath), selfPid: input.pid, selfBootedAt: input.bootedAt, alive,
  });
  let lastCrash: CrashRecord | null = null;
  if (previousRun) {
    const known = readJsonFile(recordPath) as Partial<CrashRecord> | undefined;
    // The keeper that watched that run recorded the exit status it saw. That
    // record is the better one, so this start keeps it rather than replacing it
    // with a marker-only explanation.
    if (known && known.pid === previousRun.pid && known.bootedAt === previousRun.bootedAt) {
      lastCrash = known as CrashRecord;
      // A keeper that recorded the exit before macOS wrote its report leaves a
      // reason that names only the signal. This start is the last chance to
      // attach the report's exception type and faulting frame to it.
      if (!lastCrash.ips) {
        const enriched = buildCrashRecord({
          previous: previousRun,
          exitCode: lastCrash.exitCode ?? null,
          signal: lastCrash.signal ?? null,
          source: lastCrash.source === 'marker' ? 'marker' : 'keeper',
        });
        if (enriched.ips && enriched.reason !== lastCrash.reason) lastCrash = writeCrashRecord(recordPath, enriched);
      }
    } else {
      lastCrash = writeCrashRecord(recordPath, buildCrashRecord({ previous: previousRun, exitCode: null, signal: null, source: 'marker' }));
    }
  }
  let owned = claim();

  return {
    get marker() { return marker; },
    previousRun,
    lastCrash,
    markerPath,
    recordPath,
    rememberConversation(conversationId) {
      if (!owned || marker.conversationId === conversationId) return;
      marker = { ...marker, conversationId };
      try { writeBody(marker); } catch { /* the marker is advisory for the next start */ }
    },
    removeMarker() {
      if (!owned) return;
      try {
        if (Number((readJsonFile(markerPath) as { pid?: unknown } | undefined)?.pid) === input.pid) unlinkSync(markerPath);
      } catch { /* already gone */ }
      owned = false;
    },
  };
}
