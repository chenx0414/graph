/**
 * The machine rules around the isolated instance: one Electron at a time, a
 * bounded number of start-up attempts, and proof that the user's own app was
 * never touched.
 *
 * Why these rules exist rather than "just launch it": on this host every Electron
 * start from the agent harness dies in ~100ms (SIGSEGV inside IOKit), and each
 * death puts a system crash dialog in front of the person using the machine. The
 * number of launches is therefore the only knob a test has, and it has to be a
 * small, fixed number.
 *
 * See the note at the bottom for what can and cannot silence those dialogs.
 */
import { closeSync, openSync, readdirSync, statSync, unlinkSync, writeSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import {
  RUNNING_APP_PIDS, alive, diagnosticReportsDir, isSandboxed, launchKeeper, readJsonSync, sleep, userConsolePath, waitFor,
  type InstancePaths, type KeeperHandle,
} from './desktop-crash-recovery.fixture.ts';

/** Start-up attempts for the isolated instance: three launches, no more. */
export const STARTUP_ATTEMPTS = 3;
/** Backoff schedule: before attempt 2, before attempt 3, and (unused, because the
 * cap is 3 attempts) the 8s step a fourth attempt would have waited. */
export const STARTUP_DELAYS_MS = [2_000, 4_000, 8_000] as const;
/** The waits this run actually uses, for the failure message. */
const usedDelays = STARTUP_DELAYS_MS.slice(0, STARTUP_ATTEMPTS - 1).map(ms => `${ms / 1_000}s`).join('→');

/** Machine-wide "one Electron instance at a time" for this suite. */
const electronSlotFile = () => join(tmpdir(), 'graph-crash-recovery-electron.slot');

export async function acquireElectronSlot(label: string, timeoutMs = 120_000): Promise<void> {
  const path = electronSlotFile();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(path, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, at: Date.now(), label })); } finally { closeSync(fd); }
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const owner = Number((readJsonSync(path) as { pid?: number } | undefined)?.pid);
      // A live owner means another run of this suite is driving Electron; a dead
      // one is a stale slot from a killed run and may be taken over.
      if (owner > 0 && owner !== process.pid && alive(owner)) { await sleep(250); continue; }
      try { unlinkSync(path); } catch { /* raced with its owner */ }
    }
  }
  throw new Error(`another Electron instance from this suite still holds ${path}`);
}

export function releaseElectronSlot(): void {
  if (Number((readJsonSync(electronSlotFile()) as { pid?: number } | undefined)?.pid) !== process.pid) return;
  try { unlinkSync(electronSlotFile()); } catch { /* already gone */ }
}

export interface UserInstanceSnapshot {
  record: { url?: string; pid?: number; startedAt?: number } | undefined;
  appPids: { pid: number; alive: boolean }[];
  port: number | undefined;
}

export const captureUserInstance = (): UserInstanceSnapshot => {
  const record = readJsonSync(userConsolePath) as UserInstanceSnapshot['record'];
  return {
    record,
    appPids: RUNNING_APP_PIDS.map(pid => ({ pid, alive: alive(pid) })),
    port: record?.url ? Number(new URL(record.url).port) : undefined,
  };
};

/**
 * The user's running app, checked around every launch: same app pids, same daemon
 * pid, same address, still answering. This test may only ever signal the pids it
 * started itself, and this is what proves it did not.
 */
export async function assertUserInstance(snapshot: UserInstanceSnapshot, label: string): Promise<void> {
  for (const entry of snapshot.appPids) {
    if (entry.alive) expect(alive(entry.pid), `${label}: the running Graph.app pid ${entry.pid} is untouched`).toBe(true);
  }
  const { record } = snapshot;
  if (!record?.pid || !record.url) return;
  expect(alive(record.pid), `${label}: the user daemon pid ${record.pid} is untouched`).toBe(true);
  const now = readJsonSync(userConsolePath) as { url?: string; pid?: number; startedAt?: number } | undefined;
  expect(now?.pid, `${label}: the user daemon is still the same process`).toBe(record.pid);
  expect(now?.url, `${label}: the user daemon still serves port ${snapshot.port}`).toBe(record.url);
  expect(now?.startedAt, `${label}: the user daemon never started over`).toBe(record.startedAt);
  const health = await fetch(`${record.url}/api/health`).catch(() => undefined);
  expect(health?.ok, `${label}: the user daemon still answers on port ${snapshot.port}`).toBe(true);
}

/**
 * a5, said once: the snapshot taken before the test and the one taken after it
 * describe the same process on the same address with the same start time.
 */
export function assertSameUserInstance(before: UserInstanceSnapshot, after: UserInstanceSnapshot, label: string): void {
  expect(after.record?.pid, `${label}: the user daemon pid is the same as before the test`).toBe(before.record?.pid);
  expect(after.record?.url, `${label}: the user daemon address is the same as before the test`).toBe(before.record?.url);
  expect(after.record?.startedAt, `${label}: the user daemon start time is the same as before`).toBe(before.record?.startedAt);
  for (const entry of before.appPids) {
    if (entry.alive) expect(alive(entry.pid), `${label}: Graph.app pid ${entry.pid} is still alive`).toBe(true);
  }
}

export interface LaunchFailureInput {
  artifacts: string;
  startedAt: number;
  reason: string;
  paths?: InstancePaths;
  cdpPort: number;
  output: string;
  keeperLog: string;
}

/** Every failed launch leaves the same evidence behind, including the reports. */
export async function writeLaunchFailure(input: LaunchFailureInput): Promise<string[]> {
  const reports = diagnosticReportsDir();
  const fresh: string[] = [];
  try {
    for (const name of readdirSync(reports)) {
      if (!name.endsWith('.ips')) continue;
      try { if (statSync(join(reports, name)).mtimeMs >= input.startedAt) fresh.push(name); } catch { /* vanished */ }
    }
  } catch { /* no report directory on this machine */ }
  mkdirSync(input.artifacts, { recursive: true });
  writeFileSync(join(input.artifacts, `launch-failure-${Date.now()}.md`), [
    '# The isolated Electron instance never came up',
    '',
    `reason: ${input.reason}`,
    `artifacts: ${input.artifacts}`,
    `userData: ${input.paths?.userData ?? '(not created)'}`,
    `cdp port: ${input.cdpPort}`,
    `keeper log: ${input.paths?.keeperLogPath ?? '(none)'}`,
    '',
    '## keeper and app output',
    '```',
    input.output.slice(-8000),
    '```',
    '',
    '## crash reports written during this run',
    ...fresh.map(name => `- ${join(reports, name)}`),
    '',
    '## keeper log',
    '```',
    input.keeperLog.slice(-4000),
    '```',
    '',
  ].join('\n'));
  return fresh;
}

/**
 * Why this suite refuses to run inside the command sandbox.
 *
 * Two measurements decide it, both from 2026-11-04 on this machine: an Electron
 * started under the command sandbox dies inside IOKit in ~100ms (all 14 crash
 * reports in `~/Library/Logs/DiagnosticReports` say so), and a sandboxed process
 * cannot even signal a host-session process (`kill -0` → "Operation not
 * permitted"), so a2 could not kill the app either. Refusing costs zero
 * instances and zero crash dialogs; the graph's check module declares
 * `sandbox: false` and is where this suite is meant to run.
 */
export function sandboxBlocker(): Error {
  return new Error([
    '环境阻塞：本进程在 Graph 的 deny-default seatbelt profile 内，不能跑这条 E2E',
    '  · 沙箱内 Electron 必崩：启动后 ~100ms 在 IOKit+45340 / x0==0 处 SIGSEGV（本机 14 份 .ips 一致）',
    '  · 沙箱内也无法强杀宿主会话的进程：kill -0 / TERM / KILL 均返回 Operation not permitted',
    '  因此本轮 0 个 Electron 实例、0 个系统弹窗被消耗。',
    '  这条用例要在本图的 check 模块里跑（模块已声明 sandbox:false，宿主以普通进程执行）：',
    '    node node_modules/vitest/vitest.mjs run tests/e2e/desktop-crash-recovery.test.ts',
  ].join('\n'));
}

/** Throws the blocker when this process is sandboxed; a no-op otherwise. */
export function assertNotSandboxed(sandboxed: boolean): void {
  if (sandboxed) throw sandboxBlocker();
}

export interface StartedInstance {
  keeper: KeeperHandle;
  daemon: { url: string; pid: number; startedAt: number };
  firstRun: { pid?: number; bootedAt?: number };
  /** Idempotent: stops the keeper, the daemon this test started, and frees the slot. */
  stop(): Promise<void>;
}

/**
 * Bring the isolated instance up, at most STARTUP_ATTEMPTS times.
 *
 * One Electron instance per attempt, serialized by the slot, with the user's app
 * checked on both sides of every launch. When the attempts run out the failure
 * says what it is - an environment that cannot start Electron - rather than
 * pretending an assertion failed, and it never retries without a bound.
 */
export async function startIsolatedInstance(input: {
  paths: InstancePaths;
  cdpPort: number;
  user: UserInstanceSnapshot;
  artifacts: string;
  startedAt: number;
}): Promise<StartedInstance> {
  assertNotSandboxed(await isSandboxed());
  await acquireElectronSlot('desktop-crash-recovery');
  const failures: string[] = [];
  let keeper: KeeperHandle | undefined;
  let daemon: StartedInstance['daemon'] | undefined;
  let firstRun: StartedInstance['firstRun'] | undefined;
  let released = false;

  const stopKeeper = async () => {
    if (!keeper || keeper.process.exitCode !== null) return;
    keeper.process.kill('SIGTERM');
    await new Promise<void>(resolve => { keeper!.process.once('exit', () => resolve()); setTimeout(resolve, 5_000); });
  };
  const release = () => {
    if (released) return;
    released = true;
    releaseElectronSlot();
  };
  const stop = async () => {
    await stopKeeper();
    if (daemon && alive(daemon.pid)) { try { process.kill(daemon.pid, 'SIGTERM'); } catch { /* gone */ } }
    release();
  };

  try {
    for (let attempt = 1; attempt <= STARTUP_ATTEMPTS; attempt += 1) {
      // Before every launch: the machine's own app, unchanged.
      await assertUserInstance(input.user, `attempt ${attempt} before launch`);
      keeper = launchKeeper({ paths: input.paths, cdpPort: input.cdpPort });
      try {
        daemon = await waitFor(async () => {
          const record = readJsonSync(input.paths.consolePath) as { url?: string; pid?: number; startedAt?: number } | undefined;
          if (!record?.url || !record.pid) return undefined;
          if (input.user.record?.pid && record.pid === input.user.record.pid) return undefined;
          const response = await fetch(`${record.url}/api/health`).catch(() => undefined);
          return response?.ok ? record as StartedInstance['daemon'] : undefined;
        }, `attempt ${attempt}: the isolated daemon to publish its address`, 25_000, () => (keeper!.process.exitCode != null
          ? `the keeper exited ${keeper!.process.exitCode} before the app served anything\n${keeper!.log().slice(-3000)}`
          : undefined));
        firstRun = await waitFor(() => readJsonSync(input.paths.markerPath) as { pid?: number; bootedAt?: number } | undefined,
          `attempt ${attempt}: the run marker`, 60_000, () => (keeper!.process.exitCode != null
            ? `the keeper exited ${keeper!.process.exitCode} before the app wrote its marker\n${keeper!.log().slice(-3000)}`
            : undefined));
        break;
      } catch (error) {
        const reason = String(error);
        failures.push(`attempt ${attempt}: ${reason}`);
        const reports = await writeLaunchFailure({
          artifacts: input.artifacts, startedAt: input.startedAt, reason, paths: input.paths,
          cdpPort: input.cdpPort, output: keeper.output(), keeperLog: keeper.log(),
        });
        await stopKeeper();
        keeper = undefined;
        daemon = undefined;
        // After every launch: still the same app on the same port.
        await assertUserInstance(input.user, `attempt ${attempt} after the failed launch`);
        if (attempt < STARTUP_ATTEMPTS) {
          await sleep(STARTUP_DELAYS_MS[attempt - 1] ?? 8_000);
          continue;
        }
        release();
        throw new Error([
          `环境阻塞：Electron 启动 SEGV - ${STARTUP_ATTEMPTS} 次尝试都未能启动隔离实例（每次 1 个实例，退避 ${usedDelays}）`,
          ...failures.map(line => `  ${line.split('\n')[0] ?? line}`),
          `  证据：${input.artifacts}（launch-failure-*.md、keeper 日志、系统 .ips 路径）`,
          `  系统报告：${reports.length ? reports.map(name => join(diagnosticReportsDir(), name)).join(', ') : '本轮未写出新的 .ips'}`,
          '  这是环境问题，不是断言失败：本机从 agent harness 启动的 Electron 一律在 ~100ms 内 SIGSEGV（IOKit+45340 / x0==0）。',
        ].join('\n'));
      }
    }
    if (!keeper || !daemon || !firstRun) throw new Error('环境阻塞：Electron 启动 SEGV - 隔离实例未能启动');
    await assertUserInstance(input.user, 'after the isolated instance is up');
    return { keeper, daemon, firstRun, stop };
  } catch (error) {
    // Any other way out - including the user-instance checks failing - must not
    // leave this suite's Electron slot behind for the next run to wait on.
    await stopKeeper();
    release();
    throw error;
  }
}

/*
 * Why the crash dialogs cannot be suppressed from here (measured or documented,
 * not assumed):
 *
 * - `GRAPH_APP_USER_DATA` isolation is real but irrelevant to the dialogs: it
 *   separates the single-instance lock, state and markers. macOS writes reports
 *   to the account's ~/Library/Logs/DiagnosticReports and asks CoreServices to
 *   present the dialog, keyed on the crashing process.
 * - Background/accessory launch (`LSUIElement`, `LSBackgroundOnly`,
 *   `app.setActivationPolicy('accessory')`, `open -gj`) changes Dock, menu and
 *   activation. The previous run of this suite already ran with
 *   GRAPH_APP_BACKGROUND=1 - accessory policy - and the four dialogs still
 *   appeared. `open -gj` is also unusable here: it detaches through
 *   LaunchServices and the keeper would lose the exit status.
 * - `--noerrdialogs` and `--disable-breakpad` exist in this Electron binary
 *   (`strings` finds both) but govern Chromium's own error dialogs and crashpad
 *   upload, not the system dialog. `--disable-crash-reporter` and
 *   `CRASHREPORTER_DISABLE` are not in the binary at all - no such switch or
 *   variable exists; Electron's crashReporter only uploads, and it is not started.
 * - The only real switch is a user-level system setting
 *   (`defaults write com.apple.CrashReporter DialogType none`), i.e. hiding
 *   genuine crashes machine-wide. A test must not change that, so the only lever
 *   it has is the number of instances it launches - hence the cap above.
 */
