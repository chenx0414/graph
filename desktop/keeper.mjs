#!/usr/bin/env node
/**
 * The parent process the app cannot be for itself.
 *
 * A process that dies from SIGSEGV cannot restart itself, so the thing that
 * watches for the exit has to sit outside it. This keeper spawns the real app,
 * waits for it, and then applies one rule to both branches:
 *
 *   clean exit (code 0, no signal)  -> stop, do not restart
 *   anything else                   -> record why, restart the same conversation
 *
 * Both branches are `keeperDecision`; there is no special case for the test's
 * SIGKILL. A run that keeps dying immediately backs off and eventually stops,
 * because this Electron build has been seen dying five times in six seconds.
 *
 * Usage: node desktop/keeper.mjs [--max-restarts=N] [--app-bin=<electron>] [--] [app args...]
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  conversationIdFromRoute, crashDirectory, crashRecordPath, keeperDecision, keeperLockPath, keeperLogPath,
  processAlive, runMarkerPath,
} from './crash.ts';
import { buildCrashRecord, writeCrashRecord } from './crash-record.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** Signals macOS writes an .ips for; SIGKILL and SIGTERM are not among them. */
const REPORTED_SIGNALS = new Set(['SIGSEGV', 'SIGBUS', 'SIGILL', 'SIGABRT', 'SIGTRAP', 'SIGFPE']);
const REPORT_GRACE_MS = 3_000;
const REPORT_POLL_MS = 250;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const readJson = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return undefined; }
};

function parseArgs(argv) {
  const options = { maxRestarts: 3, appBin: process.env.GRAPH_APP_BIN, appMain: join(here, 'main.mjs'), appArgs: [] };
  let passthrough = false;
  for (const argument of argv) {
    if (passthrough) { options.appArgs.push(argument); continue; }
    if (argument === '--') { passthrough = true; continue; }
    const restarts = /^--max-restarts=(\d+)$/.exec(argument);
    if (restarts) { options.maxRestarts = Number(restarts[1]); continue; }
    const bin = /^--app-bin=(.+)$/.exec(argument);
    if (bin) { options.appBin = bin[1]; continue; }
    const main = /^--app-main=(.+)$/.exec(argument);
    if (main) { options.appMain = resolve(main[1]); continue; }
    options.appArgs.push(argument);
  }
  return options;
}

/** The same directory the app's `app.getPath('userData')` resolves to. */
function resolveUserData() {
  if (process.env.GRAPH_APP_USER_DATA) return resolve(process.env.GRAPH_APP_USER_DATA);
  if (process.platform === 'darwin') return join(homedir(), 'Library/Application Support', 'Graph');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Graph');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Graph');
}

/** Under plain node `require('electron')` is the path to the binary. */
function resolveElectron() {
  try {
    const electron = createRequire(import.meta.url)('electron');
    return typeof electron === 'string' && electron ? electron : undefined;
  } catch {
    return undefined;
  }
}

const options = parseArgs(process.argv.slice(2));
const userData = resolveUserData();
const appBin = options.appBin ?? resolveElectron();
const lockPath = keeperLockPath(userData);
const logPath = keeperLogPath(userData);

function log(message) {
  const line = `[keeper ${new Date().toISOString()}] ${message}`;
  process.stderr.write(`${line}\n`);
  try { appendFileSync(logPath, `${line}\n`); } catch { /* the log is best-effort */ }
}

/**
 * One keeper per userData, decided by `O_EXCL` creation. A lock whose pid is
 * gone is stale and may be taken over; a live one means somebody is already
 * watching this userData and a second keeper would fight it for the app.
 */
function acquireLock() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx', 0o600);
      try { writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now(), userData })); } finally { closeSync(fd); }
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') return false;
      const pid = Number(readJson(lockPath)?.pid);
      if (pid > 0 && pid !== process.pid && processAlive(pid)) return false;
      try { unlinkSync(lockPath); } catch { /* raced with its owner */ }
    }
  }
  return false;
}

function releaseLock() {
  if (Number(readJson(lockPath)?.pid) !== process.pid) return;
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function conversationFromRoute() {
  return conversationIdFromRoute(readJson(join(userData, 'last-conversation-route.json')));
}

/** What the keeper knows about the run that just ended: its own spawn record
 * plus, when the app got as far as writing one, the marker it left behind. */
function previousRun(pid, startedAt) {
  const marker = readJson(runMarkerPath(userData));
  const conversationId = typeof marker?.conversationId === 'string' && marker.conversationId
    ? marker.conversationId
    : conversationFromRoute();
  if (Number(marker?.pid) === pid && Number(marker?.bootedAt) > 0) {
    return { pid, bootedAt: Number(marker.bootedAt), conversationId };
  }
  // No marker: the app died before writing one. The spawn record is the only
  // truth left, and saying so is better than borrowing a stale marker's time.
  return { pid, bootedAt: startedAt, conversationId };
}

let attempts = 0;
let child = null;
let stopping = null;
let restartTimer = null;

function startApp(conversationId) {
  // Switches come first: Chromium reads its own switches (a debugging port, a
  // keychain stand-in) before the app path, and the app path must stay first
  // among the positional arguments.
  const args = [...options.appArgs, options.appMain];
  // On a restart the conversation is named explicitly: the keeper reads it from
  // the run that died, which is the page the user actually had open.
  if (conversationId) args.push(`--conversation=${conversationId}`);
  const startedAt = Date.now();
  const spawned = spawn(appBin, args, { stdio: 'inherit', env: process.env });
  child = spawned;
  log(`started app pid ${spawned.pid}${conversationId ? ` for conversation ${conversationId}` : ''}`);
  spawned.on('error', error => {
    log(`could not start ${appBin}: ${error.message}`);
    releaseLock();
    process.exit(2);
  });
  spawned.on('exit', (code, signal) => { void onExit({ code, signal, pid: spawned.pid, startedAt }); });
}

async function onExit({ code, signal, pid, startedAt }) {
  child = null;
  const uptimeMs = Date.now() - startedAt;
  if (stopping) {
    log(`app exited after ${stopping}; keeper stops without restarting (exit ${code ?? signal})`);
    releaseLock();
    process.exit(0);
  }
  const decision = keeperDecision({ exitCode: code, signal, uptimeMs, attempts, maxAttempts: options.maxRestarts });
  if (decision.action === 'stop-clean') {
    log(`app exited cleanly after ${uptimeMs}ms; not restarting`);
    releaseLock();
    process.exit(0);
  }
  const previous = previousRun(pid, startedAt);
  let record = buildCrashRecord({ previous, exitCode: code, signal, source: 'keeper' });
  // macOS writes its report a moment after the process dies, so a restart that
  // happens sooner would leave the reason at "the signal only". Signals that
  // produce a report get one look more; SIGKILL never does, so it does not wait.
  if (!record.ips && signal && REPORTED_SIGNALS.has(signal)) {
    const deadline = Date.now() + REPORT_GRACE_MS;
    while (!record.ips && Date.now() < deadline) {
      await sleep(REPORT_POLL_MS);
      const enriched = buildCrashRecord({ previous, exitCode: code, signal, source: 'keeper' });
      if (enriched.ips) record = enriched;
    }
  }
  writeCrashRecord(crashRecordPath(userData), record);
  log(`abnormal exit recorded: ${record.reason}`);
  if (decision.action === 'stop-crash-loop') {
    log(`stopped after ${decision.attempts + 1} runs died soon after start; read ${record.ips ?? crashRecordPath(userData)}`);
    releaseLock();
    process.exit(1);
  }
  attempts = decision.attempts;
  log(decision.delayMs ? `restarting in ${decision.delayMs}ms (attempt ${attempts})` : 'restarting now');
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startApp(previous.conversationId ?? conversationFromRoute());
  }, decision.delayMs);
}

if (!appBin) {
  process.stderr.write('keeper: no Electron binary; pass --app-bin=<path> or set GRAPH_APP_BIN\n');
  process.exit(2);
}
mkdirSync(crashDirectory(userData), { recursive: true });
if (!acquireLock()) {
  log(`another keeper already owns ${userData}; exiting`);
  process.exit(0);
}
log(`watching ${userData}, app ${options.appMain}, binary ${appBin}`);

for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(signal, () => {
    if (stopping) {
      child?.kill('SIGKILL');
      return;
    }
    stopping = signal;
    log(`${signal} received: stopping the app, no restart`);
    if (restartTimer) {
      clearTimeout(restartTimer);
      restartTimer = null;
      releaseLock();
      process.exit(0);
    }
    if (!child) {
      releaseLock();
      process.exit(0);
    }
    child.kill('SIGTERM');
    setTimeout(() => {
      child?.kill('SIGKILL');
      releaseLock();
      process.exit(0);
    }, 10_000).unref();
  });
}

startApp(null);
