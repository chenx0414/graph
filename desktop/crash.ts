/**
 * Pure helpers for "the app came back and can say why it left".
 *
 * The desktop shell dies without running any handler when Electron crashes, so
 * three separate facts have to survive it: a run marker on disk (`last-run`),
 * the exit status only the parent process can see (the keeper), and the system
 * crash report macOS writes after the fact. This module decides what those
 * facts mean; it touches no filesystem so the same rule runs in the app, in the
 * keeper and in the end-to-end test.
 */
import { join } from 'node:path';
import { isLoopbackUrl } from './lib.ts';

export type CrashMarkerSource = 'keeper' | 'marker';

export interface RunMarker {
  version: 1;
  /** pid of the app run this marker belongs to. */
  pid: number;
  /** Epoch ms at which that run started; the other half of the pid identity. */
  bootedAt: number;
  conversationId?: string | null;
  electron?: string;
  appVersion?: string;
}

export interface CrashRecord {
  version: 1;
  /** Epoch ms at which the abnormal exit was detected. */
  at: number;
  pid: number;
  bootedAt: number;
  conversationId?: string | null;
  exitCode: number | null;
  signal: string | null;
  /** The sentence a person reads. Never "unknown": it names the sources it asked. */
  reason: string;
  source: 'ips' | CrashMarkerSource;
  /** The macOS crash report the reason was read from, when there was one. */
  ips?: string;
}

/** The facts worth keeping from one `~/Library/Logs/DiagnosticReports/*.ips`. */
export interface CrashReportFacts {
  path: string;
  pid: number;
  capturedAt: number;
  exceptionType?: string;
  signal?: string;
  subtype?: string;
  termination?: string;
  /** Faulting image and offset, e.g. `IOKit+45340`. */
  frame?: string;
  /** First argument register of the faulting frame; `0` is the NULL-handle shape. */
  faultAddress?: string;
}

const SIGNAL_NUMBERS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGEMT: 7,
  SIGFPE: 8, SIGKILL: 9, SIGBUS: 10, SIGSEGV: 11, SIGSYS: 12, SIGPIPE: 13,
  SIGALRM: 14, SIGTERM: 15, SIGURG: 16, SIGSTOP: 17, SIGTSTP: 18, SIGCONT: 19,
};

/** How long a report may sit outside the run window and still be that run's. */
const REPORT_SLACK_MS = 60_000;

export function crashDirectory(userData: string): string {
  return join(userData, 'crash');
}

/** Written by the app before it is ready; deleted on a normal quit. Present at
 * the next start means the previous run never got that far. */
export function runMarkerPath(userData: string): string {
  return join(crashDirectory(userData), 'last-run.json');
}

/** Written by whoever saw the abnormal exit; read on the next start. */
export function crashRecordPath(userData: string): string {
  return join(crashDirectory(userData), 'last-crash.json');
}

/** One keeper per userData; `O_EXCL` creation is what makes that atomic. */
export function keeperLockPath(userData: string): string {
  return join(crashDirectory(userData), 'keeper.lock');
}

export function keeperLogPath(userData: string): string {
  return join(crashDirectory(userData), 'keeper.log');
}

/** `process.kill(pid, 0)` is the only portable liveness probe; EPERM means alive. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === 'EPERM';
  }
}

/**
 * Was the marker we found on disk left by a run that is gone?
 *
 * Two checks, because a pid alone is not an identity: a live pid belongs to
 * somebody else (a concurrent instance owns the marker, so we must not touch
 * it), and a pid equal to our own belongs to the dead run whose number we were
 * just given - `bootedAt` is what tells the two apart.
 */
export function crashMarker(input: {
  marker: unknown;
  selfPid: number;
  selfBootedAt: number;
  alive?: (pid: number) => boolean;
}): RunMarker | null {
  const alive = input.alive ?? processAlive;
  const value = input.marker && typeof input.marker === 'object' ? input.marker as Record<string, unknown> : null;
  const pid = asNumber(value?.pid);
  const bootedAt = asNumber(value?.bootedAt);
  if (pid === undefined || pid <= 0 || bootedAt === undefined || bootedAt <= 0) return null;
  const conversationId = typeof value?.conversationId === 'string' && value.conversationId ? value.conversationId : null;
  const marker: RunMarker = {
    version: 1, pid, bootedAt, conversationId,
    ...(asText(value?.electron) ? { electron: asText(value?.electron)! } : {}),
    ...(asText(value?.appVersion) ? { appVersion: asText(value?.appVersion)! } : {}),
  };
  if (pid === input.selfPid) {
    // Ours would be this run, and this run has not written one yet: the marker
    // is from an older process that held the same pid.
    return Math.abs(input.selfBootedAt - bootedAt) > 1_000 ? marker : null;
  }
  return alive(pid) ? null : marker;
}

const parseReportTime = (value: unknown): number | undefined => {
  if (typeof value !== 'string') return undefined;
  // `2026-11-04 17:38:33.2148 +0800`, and the header's `2026-11-04 17:38:35.00 +0800`.
  const normalized = value.trim().replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2');
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/** Read one `.ips`: a one-line JSON header, then the JSON body. */
export function parseCrashReport(text: string, path: string): CrashReportFacts | null {
  const brace = text.indexOf('\n{');
  let header: Record<string, unknown> = {};
  let body: Record<string, unknown>;
  try {
    if (brace < 0) body = JSON.parse(text) as Record<string, unknown>;
    else {
      header = JSON.parse(text.slice(0, brace)) as Record<string, unknown>;
      body = JSON.parse(text.slice(brace + 1)) as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  const pid = asNumber(body.pid ?? header.pid);
  const capturedAt = parseReportTime(body.captureTime ?? header.timestamp);
  if (pid === undefined || capturedAt === undefined) return null;
  const exception = asRecord(body.exception);
  const termination = asRecord(body.termination);
  const threads = Array.isArray(body.threads) ? body.threads.map(asRecord) : [];
  const thread = threads[asNumber(body.faultingThread) ?? 0];
  const frames = Array.isArray(thread?.frames) ? (thread!.frames as unknown[]).map(asRecord) : [];
  const images = Array.isArray(body.usedImages) ? body.usedImages.map(asRecord) : [];
  const frame0 = frames[0];
  const image = frame0 ? images[asNumber(frame0.imageIndex) ?? -1] : undefined;
  const offset = frame0 ? asNumber(frame0.imageOffset) : undefined;
  const x = asRecord(asRecord(thread?.threadState)?.x);
  const faultAddress = asText(Array.isArray(x) ? asRecord((x as unknown[])[0])?.value : undefined);
  return {
    path, pid, capturedAt,
    ...(asText(exception?.type) ? { exceptionType: asText(exception?.type)! } : {}),
    ...(asText(exception?.signal) ? { signal: asText(exception?.signal)! } : {}),
    ...(asText(exception?.subtype) ? { subtype: asText(exception?.subtype)! } : {}),
    ...(asText(termination?.indicator) ?? asText(termination?.namespace)
      ? { termination: (asText(termination?.indicator) ?? asText(termination?.namespace))! }
      : {}),
    ...(image && offset !== undefined ? { frame: `${String(image.name ?? image.path ?? '?')}+${offset}` } : {}),
    ...(faultAddress ? { faultAddress } : {}),
  };
}

/**
 * The report that belongs to this run: same pid, captured inside the run's own
 * window. Two processes can share a pid across boots, so the window, not the
 * pid, is what keeps a stale report from explaining a fresh crash.
 */
export function selectCrashReport(
  reports: CrashReportFacts[],
  input: { pid: number; bootedAt: number; at: number },
): CrashReportFacts | null {
  let best: CrashReportFacts | null = null;
  for (const report of reports) {
    if (report.pid !== input.pid) continue;
    if (report.capturedAt < input.bootedAt - REPORT_SLACK_MS) continue;
    if (report.capturedAt > input.at + REPORT_SLACK_MS) continue;
    if (!best || report.capturedAt > best.capturedAt) best = report;
  }
  return best;
}

/**
 * The one sentence shown for a run that did not exit normally.
 *
 * The order is fixed: the signal or exit code the keeper saw, then the system
 * crash report, then - if neither exists - a sentence that says which sources
 * were asked and why they were empty. It never says "unknown": the caller
 * always has at least the marker it just read.
 */
export function crashReason(input: {
  bootedAt: number;
  exitCode: number | null;
  signal: string | null;
  report?: CrashReportFacts | null;
  source: CrashMarkerSource;
}): string {
  const report = input.report ?? null;
  const status: string[] = [];
  if (input.signal) {
    const number = SIGNAL_NUMBERS[input.signal];
    status.push(`被信号 ${input.signal}${number === undefined ? '' : `(${number})`} 终止`);
  } else if (input.exitCode !== null && input.exitCode !== 0) {
    status.push(`退出码 ${input.exitCode}`);
  }
  if (report) {
    const exception = [report.exceptionType, report.subtype].filter(Boolean).join(' / ');
    const where = [report.frame, formatLocalStamp(report.capturedAt)].filter(Boolean).join('，');
    status.push(`${exception || '系统崩溃报告'}${where ? `（${where}）` : ''}`);
  } else if (input.source === 'keeper') {
    status.push('系统未留该进程的 .ips 崩溃报告，原因取自看护进程报回的退出状态');
  } else {
    status.push(`系统未留该进程的 .ips 崩溃报告，也没有看护进程报回退出码或信号（进程在 ${formatLocalStamp(input.bootedAt)} 之后被强杀、断电或系统回收）`);
  }
  if (status.length === 0) return `上一次运行未正常退出（进程于 ${formatLocalStamp(input.bootedAt)} 启动）`;
  return status.join('，');
}

/** `SIGKILL(9) · 11-04 17:41` - the status bar line, not the whole story. */
export function crashLabel(record: CrashRecord | null | undefined): string | null {
  if (!record) return null;
  const number = record.signal ? SIGNAL_NUMBERS[record.signal] : undefined;
  const head = record.signal
    ? `${record.signal}${number === undefined ? '' : `(${number})`}`
    : record.exitCode !== null && record.exitCode !== 0 ? `退出码 ${record.exitCode}` : '进程消失';
  return `上次异常退出：${head} · ${formatLocalShort(record.at)}`;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Local `MM-DD HH:mm:ss`, the stamp a person can compare with a log line. */
export function formatLocalStamp(ms: number): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '';
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** Local `MM-DD HH:mm`, for lines that must stay short. */
export function formatLocalShort(ms: number): string {
  const at = new Date(ms);
  if (Number.isNaN(at.getTime())) return '';
  return `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

export interface KeeperDecision {
  action: 'stop-clean' | 'restart' | 'restart-backoff' | 'stop-crash-loop';
  /** Consecutive short-lived runs, carried into the next decision. */
  attempts: number;
  delayMs: number;
}

/**
 * What the keeper does after one run ended. Both acceptance branches are the
 * same rule: a clean exit stops (`stop-clean`), everything else restarts - but
 * a run that dies immediately restarts with backoff and eventually stops, since
 * the same Electron build has been seen dying five times in six seconds.
 */
export function keeperDecision(input: {
  exitCode: number | null;
  signal: string | null;
  uptimeMs: number;
  attempts: number;
  /** A run that lived this long counts as working, and resets the backoff. */
  stableMs?: number;
  maxAttempts?: number;
}): KeeperDecision {
  const stableMs = input.stableMs ?? 30_000;
  const maxAttempts = input.maxAttempts ?? 3;
  if (input.signal === null && input.exitCode === 0) return { action: 'stop-clean', attempts: 0, delayMs: 0 };
  if (input.uptimeMs >= stableMs) return { action: 'restart', attempts: 0, delayMs: 0 };
  if (input.attempts >= maxAttempts) return { action: 'stop-crash-loop', attempts: input.attempts, delayMs: 0 };
  return { action: 'restart-backoff', attempts: input.attempts + 1, delayMs: Math.min(1_000 * 2 ** input.attempts, 30_000) };
}

export interface ConsoleAddressRecord {
  url: string;
  pid: number;
  mode: string;
  startedAt: number;
}

/**
 * A daemon this app may take over instead of starting a second one: the
 * recorded loopback address, a pid that is still alive, and a start time that
 * makes it a real record. The caller still probes the address before adopting.
 */
export function adoptableConsole(record: unknown, alive: (pid: number) => boolean): ConsoleAddressRecord | null {
  if (!record || typeof record !== 'object') return null;
  const value = record as Record<string, unknown>;
  const pid = asNumber(value.pid);
  const startedAt = asNumber(value.startedAt);
  if (typeof value.url !== 'string' || !isLoopbackUrl(value.url)) return null;
  if (pid === undefined || pid <= 0 || startedAt === undefined || startedAt <= 0) return null;
  if (!alive(pid)) return null;
  return { url: value.url, pid, mode: typeof value.mode === 'string' ? value.mode : 'view', startedAt };
}

/** `--conversation=<id>`, the conversation a restart has to come back to. */
export function parseConversationArg(argv: string[]): string | null {
  for (const argument of argv) {
    const match = /^--conversation=([A-Za-z0-9_-]+)$/.exec(argument);
    if (match) return match[1]!;
  }
  return null;
}

/** The conversation a stored console route points at, if it points at one. */
export function conversationIdFromRoute(route: string | null | undefined): string | null {
  if (typeof route !== 'string') return null;
  const match = /^#\/conversations\/([A-Za-z0-9_-]+)$/.exec(route);
  return match ? match[1]! : null;
}

const asNumber = (value: unknown): number | undefined => {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : undefined;
};

const asText = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() ? value : undefined);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
