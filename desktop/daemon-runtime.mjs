/**
 * The daemon this app talks to: spawn a new one, or adopt the one a killed app
 * left behind.
 *
 * Adoption is the whole point. The daemon holds the tasks, the graph runtime
 * and the work that is running right now; a second daemon on the same state
 * directory would give one sqlite file two writers and would restart the work
 * instead of continuing it. A daemon that is still answering on its recorded
 * loopback address is therefore taken over, not replaced.
 *
 * Output goes to `state/daemon.log` rather than a pipe: a pipe back into the
 * app dies with the app, and the daemon's next write would then kill it (Go's
 * SIGPIPE on fd 1 is fatal). A file survives both the app and the crash.
 */
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import { daemonArgs, tailText } from './lib.ts';
import { adoptableConsole, processAlive } from './crash.ts';
import { stopDaemonProcess } from './daemon-process.ts';

/** Reading a JSON file is all this module needs from the app's path helpers, and
 * importing them would drag Electron in and make the daemon runtime untestable
 * outside it. */
const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

const LOG_CEILING_BYTES = 5 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 30_000;
const WATCH_INTERVAL_MS = 3_000;
/** How long a vanished daemon may be replaced before the reader is told. */
const RECOVERY_MS = 15_000;

export function createDaemonRuntime(input) {
  let child = null;
  let adoptedPid = null;
  let watch = null;
  let recovering = false;

  const logPath = stateDir => join(stateDir, 'daemon.log');

  function openLog(stateDir) {
    const path = logPath(stateDir);
    try {
      // A log only has to cover the last failure; a long-lived app must not hand
      // the next launch a multi-gigabyte file to read.
      if (statSync(path).size > LOG_CEILING_BYTES) writeFileSync(path, '');
    } catch { /* first run */ }
    return openSync(path, 'a', 0o600);
  }

  function logTail(stateDir, lines = 12) {
    try { return tailText(readFileSync(logPath(stateDir), 'utf8'), lines); } catch { return ''; }
  }

  function clearWatch() {
    if (watch) clearInterval(watch);
    watch = null;
  }

  function start() {
    const paths = input.paths();
    mkdirSync(paths.stateDir, { recursive: true });
    mkdirSync(dirname(paths.configPath), { recursive: true });
    const hasConfig = input.prepare(paths);
    const known = adoptableConsole(readJson(join(paths.stateDir, 'console.json')), processAlive);
    if (known) void adopt(paths, known, hasConfig);
    else spawnDaemon(paths, hasConfig);
  }

  async function adopt(paths, known, hasConfig) {
    let serving = false;
    try {
      const response = await fetch(`${known.url}/`, { method: 'GET' });
      serving = response.ok;
    } catch { serving = false; }
    // A pid can outlive its usefulness (a wedged daemon); the address answering
    // is what makes the adoption real, so both conditions must hold.
    if (!serving) {
      spawnDaemon(paths, hasConfig);
      return;
    }
    if (input.isQuitting()) return;
    child = null;
    adoptedPid = known.pid;
    if (input.verbose) input.log?.(`[app] adopted daemon pid ${known.pid} at ${known.url}`);
    input.onReady(known.url);
    clearWatch();
    // An adopted daemon is not our child, so there is no exit event to wait for.
    watch = setInterval(() => {
      if (input.isQuitting() || input.isRestarting() || processAlive(known.pid)) return;
      clearWatch();
      if (input.rejectPending(new Error(`adopted daemon ${known.pid} exited`))) return;
      void daemonGone(paths, 'Graph daemon stopped', `adopted daemon pid ${known.pid} exited\n${logTail(paths.stateDir, 8)}`);
    }, WATCH_INTERVAL_MS);
  }

  /**
   * A daemon that vanished is not automatically a crash.
   *
   * Every self-improvement restarts the daemon under a running window, and the
   * reader used to get a modal "Graph daemon stopped" and an app that quit -
   * measured 2026-11-06, reported as "桌面有一个 Electron 崩溃退出的提示，遇到好多次".
   * So: wait for the replacement the host is starting (it publishes its own
   * console.json), adopt it, and keep the window; only when nothing answers in
   * RECOVERY_MS spawn one, and let a failing spawn take the onGone path.
   */
  async function daemonGone(paths, title, message) {
    if (recovering || input.isQuitting()) return;
    recovering = true;
    try {
      const hasConfig = input.prepare(paths);
      const deadline = Date.now() + RECOVERY_MS;
      while (Date.now() < deadline) {
        if (input.isQuitting()) return;
        const candidate = adoptableConsole(readJson(join(paths.stateDir, 'console.json')), processAlive);
        if (candidate && candidate.pid !== adoptedPid && candidate.pid !== child?.pid) {
          if (input.verbose) input.log?.(`[app] daemon replaced by pid ${candidate.pid}; adopting it`);
          await adopt(paths, candidate, hasConfig);
          return;
        }
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      if (input.verbose) input.log?.('[app] no replacement daemon appeared; starting one');
      spawnDaemon(paths, hasConfig);
    } finally {
      recovering = false;
    }
  }

  function spawnDaemon(paths, hasConfig) {
    const args = daemonArgs({ paths, port: 0, mode: 'execute', hasConfig, dynamic: true });
    const bundledNode = join(paths.root, 'runtime/node');
    const fd = openLog(paths.stateDir);
    let startedChild;
    try {
      startedChild = spawn(input.bin(paths), [...args, '--application-root', paths.sourceRoot], {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(existsSync(bundledNode) ? { GRAPH_APP_NODE: bundledNode } : {}), ...input.secrets() },
        stdio: ['ignore', fd, fd],
      });
    } finally {
      closeSync(fd);
    }
    child = startedChild;
    adoptedPid = null;
    if (input.verbose) input.log?.(`[app] spawned daemon pid ${startedChild.pid}, log ${logPath(paths.stateDir)}`);
    startedChild.on('error', error => {
      if (child !== startedChild) return;
      // A spawn that never produced a process has no exit to wait for, so the
      // quit path must not try to stop it.
      child = null;
      input.onGone('Graph daemon failed to start', String(error));
    });
    startedChild.on('exit', (code, signal) => {
      if (child !== startedChild) return;
      child = null;
      if (input.isQuitting() || input.isRestarting()) {
        input.rejectPending(new Error(`daemon stopped during restart (exit ${code ?? signal})`));
        return;
      }
      void daemonGone(paths, 'Graph daemon stopped', `exit ${code ?? signal}\n${logTail(paths.stateDir, 8)}`);
    });
    void waitForAddress(startedChild, paths);
  }

  /** The daemon publishes its bound address once the socket is listening. */
  async function waitForAddress(startedChild, paths) {
    const deadline = Date.now() + STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (child !== startedChild) return;
      const record = readJson(join(paths.stateDir, 'console.json'));
      if (record && record.pid === startedChild.pid && typeof record.url === 'string') {
        input.onReady(record.url);
        return;
      }
      if (startedChild.exitCode !== null || startedChild.signalCode !== null) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (child !== startedChild) return;
    input.onGone('Graph daemon failed to start', logTail(paths.stateDir) || 'no console address within 30s');
  }

  async function stop() {
    clearWatch();
    if (child) return stopDaemonProcess(child);
    const pid = adoptedPid;
    adoptedPid = null;
    if (!pid || !processAlive(pid)) return undefined;
    try { process.kill(pid, 'SIGTERM'); } catch { return undefined; }
    return new Promise(resolveStop => {
      const deadline = Date.now() + 5_000;
      const tick = () => {
        if (!processAlive(pid)) resolveStop();
        else if (Date.now() > deadline) {
          try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
          resolveStop();
        } else setTimeout(tick, 100);
      };
      tick();
    });
  }

  return {
    start,
    stop,
    logTail,
    get pid() { return child?.pid ?? adoptedPid; },
    get adopted() { return adoptedPid !== null && child === null; },
  };
}
