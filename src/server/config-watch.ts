/**
 * The configuration file is watched, so a hand edit takes effect without a restart.
 *
 * Three rules keep it honest:
 * - the document's **content** decides whether anything changed, not its
 *   `revision`: whoever edits the file by hand rarely bumps that number, and the
 *   revision stays what it always was — the optimistic lock for concurrent saves;
 * - the daemon's own saves echo back through the watcher and are dropped by the
 *   digest, so nothing applies twice;
 * - a document that does not parse or does not validate changes nothing: the
 *   previous configuration stays effective and the reason is reported.
 */
import { createHash } from 'node:crypto';
import { watch as watchDefault, type FSWatcher } from 'node:fs';
import { readFile as readFileDefault } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import type { ApplyResult } from './live-config.ts';
import type { GraphConfig } from './config.ts';

export interface ConfigWatchReport {
  watching: boolean;
  /** Change events seen, including the ones dropped as duplicates. */
  events: number;
  /** Documents that parsed and were handed to the applier. */
  applied: number;
  /** Documents whose digest matched the last applied one. */
  ignored: number;
  lastEventAt: number | null;
  lastReason: string | null;
  /** The `revision` the file carried when it was last read. */
  fileRevision: number | null;
}

export interface ConfigWatch {
  /** Read the file once and act on it. The fs watcher calls this, tests call it directly. */
  handleChange(): Promise<void>;
  report(): ConfigWatchReport;
  stop(): void;
}

/** A stable digest of the document, so key order and whitespace never count as a change. */
export function configDigest(config: object): string {
  const canonical = JSON.stringify(config, (_key, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)));
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function createConfigWatch(options: {
  path: string;
  log: (line: string) => void;
  /**
   * Validate a document read from disk; throw a message worth reporting. The
   * revision is reported separately because it belongs to the file, not to the
   * parsed configuration (the config store owns it as an optimistic lock).
   */
  parse: (text: string) => { config: GraphConfig; revision: number | null };
  apply: (config: GraphConfig, revision: number) => ApplyResult;
  /** Tests drive `handleChange` themselves. */
  watch?: boolean;
  debounceMs?: number;
  readFile?: (path: string) => Promise<string>;
  now?: () => number;
}): ConfigWatch {
  const readFile = options.readFile ?? (async path => await readFileDefault(path, 'utf8'));
  const now = options.now ?? Date.now;
  let lastDigest: string | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const report: ConfigWatchReport = { watching: false, events: 0, applied: 0, ignored: 0, lastEventAt: null, lastReason: null, fileRevision: null };

  const handleChange = async () => {
    report.events += 1;
    report.lastEventAt = now();
    let text: string;
    try {
      text = await readFile(options.path);
    } catch (error) {
      report.lastReason = `config file unreadable: ${(error as Error).message}`;
      options.log(`Configuration file unreadable: ${(error as Error).message}`);
      return;
    }
    let parsed: { config: GraphConfig; revision: number | null };
    try {
      parsed = options.parse(text);
    } catch (error) {
      report.lastReason = (error as Error).message;
      options.log(`Configuration file not applied: ${(error as Error).message}`);
      return;
    }
    report.fileRevision = parsed.revision;
    // A save that only bumps the revision is not a change: the digest is taken
    // over the configuration, so the daemon's own write stays silent.
    const digest = configDigest(parsed.config);
    if (digest === lastDigest) { report.ignored += 1; return; }
    const result = options.apply(parsed.config, parsed.revision ?? 0);
    if (result.applied) {
      lastDigest = digest;
      report.applied += 1;
      report.lastReason = null;
      options.log(`Configuration file applied (revision ${report.fileRevision ?? 'unset'}).`);
    } else {
      report.lastReason = result.reason ?? 'rejected';
      options.log(`Configuration file not applied: ${report.lastReason}`);
    }
  };

  let watcher: FSWatcher | null = null;
  if (options.watch !== false) {
    const debounceMs = options.debounceMs ?? 300;
    try {
      // Watch the directory: an atomic save replaces the file by rename, which a
      // watch on the file itself would miss.
      watcher = watchDefault(dirname(options.path), { persistent: false }, (_event, filename) => {
        if (filename && basename(filename as string) !== basename(options.path)) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => { timer = null; void handleChange(); }, debounceMs);
      });
      watcher.on('error', error => { options.log(`Configuration watch stopped: ${String(error)}`); });
      report.watching = true;
    } catch (error) {
      options.log(`Configuration watch unavailable: ${String(error)}`);
    }
  }

  return {
    handleChange,
    report: () => ({ ...report }),
    stop: () => { if (timer) clearTimeout(timer); timer = null; watcher?.close(); watcher = null; report.watching = false; },
  };
}
