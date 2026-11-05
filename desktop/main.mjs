// graph:allow-large-file: the Electron entry point owns the window, the daemon lifecycle, the tray, notifications and the keychain bridge in one process; splitting it is a real refactor that needs an Electron-capable host to re-verify, and this host cannot launch Electron at all.
import { drawerWindowBounds } from './drawer-window.ts';
import { createConsoleWindow, reportDaemonError } from './console-window.mjs';
import { currentAppPaths, findPackagedDaemon, secretsFromKeychain } from './runtime-files.mjs';
import { fileSecretsCodec, secretsKeyPath } from './secrets-codec.mjs';
/**
 * Owns desktop windows, the Go daemon and the secret store.
 * Secrets pass through the daemon environment and stay out of config files.
 *
 * A change in this file reaches the reader only when the package they launch
 * contains it: `app:build` produces dist/app/mac-arm64/Graph.app and
 * scripts/install-desktop-app.mjs is what puts it in /Applications. Measured
 * 2026-11-05, after three receipts reported a desktop fix as live while
 * /Applications kept a bundle from 2026-10-20 and the reader restarted an app
 * that never carried a line of it.
 */
import { app, Menu, Notification, Tray, dialog, ipcMain, nativeImage, shell, screen } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  restoreConsoleRoute, consoleReloadAction, applySecretRequest, ensureConfigFile, loadRawSecretEntries,
  resourceDirectory, rsiRestartDecision, saveSecrets, taskNotifications, trayIconPath, trayMenuItems,
} from './lib.ts';
import { crashLabel, conversationIdFromRoute, parseConversationArg } from './crash.ts';
import { beginRun } from './run-marker.ts';
import { createDaemonRuntime } from './daemon-runtime.mjs';

app.setName('Graph');
if (process.env.GRAPH_APP_USER_DATA) app.setPath('userData', resolve(process.env.GRAPH_APP_USER_DATA));
const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const withDevTools = process.argv.includes('--dev');
const verbose = withDevTools || Boolean(process.env.GRAPH_APP_DEBUG);
const smoke = Boolean(process.env.GRAPH_APP_SMOKE);
const background = process.env.GRAPH_APP_BACKGROUND === '1' || smoke
  || (process.env.VITEST === 'true' && process.env.GRAPH_E2E_VISIBLE_WINDOWS !== '1');
if (background && process.platform === 'darwin') app.setActivationPolicy('accessory');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  let drawerBase = null;
  let quitting = false;
  let restarting = false;
  let readyUrl = null;
  let pendingReady = null;
  const userData = app.getPath('userData');
  const routePath = join(userData, 'last-conversation-route.json');
  let lastRoute = null;
  try { lastRoute = JSON.parse(readFileSync(routePath, 'utf8')); } catch { /* first launch */ }
  const bootedAt = Date.now();
  // A keeper that restarted us names the conversation to come back to; it wins
  // over the stored page because the keeper read it from the run that died.
  const restartConversation = parseConversationArg(process.argv);
  if (restartConversation) lastRoute = `#/conversations/${restartConversation}`;
  const consoleUrl = url => restoreConsoleRoute(url, typeof lastRoute === 'string' ? lastRoute : null);
  // Before anything else: claim this run and read what the previous one left.
  const run = beginRun({
    userData, pid: process.pid, bootedAt,
    conversationId: restartConversation ?? conversationIdFromRoute(typeof lastRoute === 'string' ? lastRoute : null),
    electron: process.versions.electron, appVersion: app.getVersion(),
  });
  let lastCrash = run.lastCrash;
  let secrets = {};
  let secretsPath = null;
  // Where the in-memory copy came from, so a daemon restart does not decrypt the
  // whole store again and a real change on disk still reloads it.
  let secretsReadFrom = null;
  let secretsReadStamp = 0;
  let notificationState = { primed: false, questions: {}, status: {} };
  let taskPoll = null;
  let secretPoll = null;
  let rsiPoll = null;
  let rsiRestarting = false;
  let tray = null;
  let openQuestionTotal = 0;

  function openWindow(url) {
    window = createConsoleWindow({
      url: consoleUrl(url), devRoot, withDevTools, verbose, smoke, background,
      onRoute: route => {
        lastRoute = route;
        try { writeFileSync(routePath, JSON.stringify(route)); } catch { /* optional UI state */ }
        run.rememberConversation(conversationIdFromRoute(route));
      },
      onClosed: () => { window = null; drawerBase = null; },
    });
  }

  const currentPaths = () => currentAppPaths(devRoot);

  /**
   * Secrets the Agent wrote through the bridge live only in the daemon until the
   * keychain has them. The desktop is the only writer of the keychain, so it asks
   * the daemon on a short interval and stores what the Agent requested.
   */
  async function pollSecretRequests() {
    if (!readyUrl || !secretsPath) return;
    try {
      const token = readFileSync(join(currentPaths().stateDir, 'app-token'), 'utf8').trim();
      const response = await fetch(`${readyUrl}/api/app/secret-requests`, {
        headers: { 'x-graph-app-token': token, origin: readyUrl },
      });
      if (!response.ok) return;
      const body = await response.json().catch(() => ({}));
      for (const request of Array.isArray(body.requests) ? body.requests : []) {
        const outcome = applySecretRequest(secrets, request?.ref, request?.value ?? null);
        if (!outcome.ok) continue;
        const stored = saveSecrets(secretsPath, fileSecretsCodec(secretsKeyPath(secretsPath)), outcome.secrets, (path, data) => writeFileSync(path, data, { mode: 0o600 }), {
          raw: loadRawSecretEntries(secretsPath, path => readFileSync(path, 'utf8')),
          touched: [request.ref],
        });
        // Without a keychain the request stays pending and visible instead of
        // being reported as stored; the next interval tries again.
        if (!stored) continue;
        secrets = outcome.secrets;
        await fetch(`${readyUrl}/api/app/secret`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-graph-app-token': token, origin: readyUrl },
          body: JSON.stringify({ ref: request.ref, value: request.value ?? null, persisted: true }),
        });
      }
    } catch {
      // The daemon may be restarting; the next interval retries.
    }
  }

  const daemon = createDaemonRuntime({
    paths: currentPaths,
    bin: paths => findPackagedDaemon(paths.sourceRoot, devRoot),
    secrets: () => secrets,
    // The keychain is read once per app process, not once per daemon start.
    //
    // Measured 2026-11-05: every self-improvement restarted the daemon, and this
    // hook decrypted every stored secret again - which is what macOS answers with
    // 「找不到用于储存 Graph Key 的钥匙串」 whenever the grant no longer matches the
    // app's signature. A restart changes nothing about the keychain, so a second
    // read can only cost the reader a dialog; the file's mtime is what says the
    // store moved, and a write from this process updates the map directly.
    prepare: paths => {
      const stamp = (() => {
        try { return statSync(paths.secretsPath).mtimeMs; } catch { return 0; }
      })();
      if (secretsReadFrom !== paths.secretsPath || stamp !== secretsReadStamp) {
        secrets = secretsFromKeychain(paths);
        secretsReadFrom = paths.secretsPath;
        secretsReadStamp = stamp;
      }
      secretsPath = paths.secretsPath;
      return ensureConfigFile(paths.configPath, existsSync, (path, data) => writeFileSync(path, data, { mode: 0o600 }));
    },
    verbose,
    log: line => console.log(line),
    isQuitting: () => quitting,
    isRestarting: () => restarting,
    rejectPending: error => {
      if (!pendingReady) return false;
      const rejectReady = pendingReady.reject;
      pendingReady = null;
      rejectReady(error);
      return true;
    },
    onReady: url => daemonReady(url),
    onGone: (title, message) => { reportDaemonError(title, message, background); app.quit(); },
  });

  function daemonReady(url) {
    readyUrl = url;
    if (pendingReady) {
      const ready = pendingReady;
      pendingReady = null;
      ready.resolve(url);
      return;
    }
    if (window) showConsole(url);
    else openWindow(url);
  }

  function startDaemon() {
    daemon.start();
  }

  function showConsole(url) {
    const target = consoleUrl(url);
    if (!window) {
      openWindow(url);
      return;
    }
    if (consoleReloadAction(window.webContents.getURL(), target) === 'reload') {
      window.webContents.reloadIgnoringCache();
      return;
    }
    void window.loadURL(target);
  }

  function restartDaemon() {
    restarting = true;
    return new Promise((resolveReady, rejectReady) => {
      void stopDaemon().then(() => {
        readyUrl = null;
        const timer = setTimeout(() => {
          if (pendingReady) {
            pendingReady = null;
            restarting = false;
            rejectReady(new Error('daemon restart timed out'));
          }
        }, 20_000);
        pendingReady = {
          resolve: url => {
            clearTimeout(timer);
            restarting = false;
            resolveReady(url);
          },
          reject: error => {
            clearTimeout(timer);
            restarting = false;
            rejectReady(error);
          },
        };
        startDaemon();
      });
    });
  }

  function registerBridge() {
    ipcMain.handle('graph:drawer', (event, input) => {
      if (!window || event.sender !== window.webContents || typeof input?.open !== 'boolean') return { expanded: false };
      if (!input.open) {
        if (drawerBase && !window.isFullScreen() && !window.isMaximized()) {
          const now = window.getBounds();
          window.setBounds({ ...drawerBase, y: now.y, height: now.height }, true);
        }
        drawerBase = null;
        return { expanded: false };
      }
      const width = input.width === 760 ? 760 : 440;
      const base = drawerBase ?? window.getBounds();
      const result = drawerWindowBounds(base, screen.getDisplayMatching(base).workArea, width, window.isFullScreen() || window.isMaximized());
      if (result.expanded) { drawerBase = base; window.setBounds(result.bounds, true); }
      else if (drawerBase) { window.setBounds(drawerBase, true); drawerBase = null; }
      return { expanded: result.expanded };
    });
    ipcMain.handle('graph:pick-directory', async () => {
      if (background) return null;
      const result = await dialog.showOpenDialog(window ?? undefined, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('graph:open-resource', async (_event, kind) => {
      if (kind !== 'skills' && kind !== 'mcp' && kind !== 'pi-extensions' && kind !== 'agent-md' && kind !== 'prompts') {
        return { opened: false, message: 'unknown resource library' };
      }
      const path = resourceDirectory(currentPaths().graphHome, kind);
      mkdirSync(path, { recursive: true });
      if (background) return { opened: false, path, message: 'Desktop is running in background mode' };
      const message = await shell.openPath(path);
      return message ? { opened: false, path, message } : { opened: true, path };
    });
    ipcMain.handle('graph:save-secret', async (_event, ref, value) => {
      const request = applySecretRequest(secrets, ref, value);
      if (!request.ok) return { stored: false, applied: false, message: request.message };
      if (!secretsPath) return { stored: false, applied: false, message: 'no secrets path' };
      const codec = fileSecretsCodec(secretsKeyPath(secretsPath));
      secrets = request.secrets;
      // Keep a revocation in the encrypted map too (it removes the entry), and
      // make the daemon state authoritative for the "revoked" gate.
      const stored = saveSecrets(secretsPath, codec, secrets, (path, data) => writeFileSync(path, data, { mode: 0o600 }), {
        // Same read-modify-write rule as the poller: only this ref may change.
        raw: loadRawSecretEntries(secretsPath, path => readFileSync(path, 'utf8')),
        touched: [ref],
      });
      let applied = false;
      let message;
      if (readyUrl) {
        // Hand the key/revocation to the running daemon through the
        // token-guarded local bridge; no restart is needed.
        try {
          const token = readFileSync(join(currentPaths().stateDir, 'app-token'), 'utf8').trim();
          const response = await fetch(`${readyUrl}/api/app/secret`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-graph-app-token': token, origin: readyUrl },
            body: JSON.stringify({ ref, value: request.revoked ? null : request.secrets[ref] }),
          });
          const body = await response.json().catch(() => ({}));
          applied = response.ok && body.applied === true;
          if (!response.ok || body.applied !== true) message = body.message ?? body.reason ?? `daemon bridge HTTP ${response.status}`;
        } catch (error) {
          message = String(error);
        }
      }
      // A revocation lives in the daemon's revoked-secrets file, so `applied`
      // is the meaningful proof; key storage needs both the keychain write and
      // the daemon applying it.
      const ok = request.revoked ? applied : stored && applied;
      return { stored, applied, revoked: request.revoked, ...(ok ? {} : { message: message ?? (request.revoked ? 'daemon not ready' : 'encryption unavailable; use the environment variable instead') }) };
    });
    ipcMain.handle('graph:secret-status', (_event, refs) => {
      const result = {};
      for (const ref of Array.isArray(refs) ? refs : []) {
        if (typeof ref === 'string') result[ref] = Boolean(process.env[ref]?.trim() || secrets[ref]);
      }
      return result;
    });
    ipcMain.handle('graph:relaunch', async () => {
      const url = await restartDaemon();
      // The page navigates itself after this reply so the invoke response is
      // never dropped; a missing window (no renderer) is reopened here.
      if (!window) openWindow(url);
      return { url };
    });
  }

  function focusTask(taskId) {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) return;
    if (!window && readyUrl) openWindow(readyUrl);
    if (!window) return;
    if (!background) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
    void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/tasks/${taskId}`)}`).catch(() => undefined);
  }

  function notifyDecision(decision) {
    if (background || !Notification.isSupported()) return;
    const notification = new Notification({ title: decision.title, body: decision.body });
    notification.on('click', () => focusTask(decision.taskId));
    notification.show();
  }

  function pollTasks() {
    if (!readyUrl) return;
    void fetch(`${readyUrl}/api/tasks`, { headers: { origin: readyUrl } })
      .then(async response => (response.ok ? response.json() : []))
      .then(tasks => {
        if (!Array.isArray(tasks)) return;
        const result = taskNotifications(notificationState, tasks);
        notificationState = result.state;
        for (const decision of result.notifications) notifyDecision(decision);
        if (app.dock) app.dock.setBadge(result.openTotal ? String(result.openTotal) : '');
        if (result.openTotal !== openQuestionTotal) {
          openQuestionTotal = result.openTotal;
          refreshTray();
        }
      })
      .catch(() => undefined);
  }

  // Recursive Self-Improvement: the Main Agent commits a change to the Graph
  // source checkout and writes a restart request. Once no operation is running
  // any more, reload the daemon so the new code is live. The request is only
  // cleared after the reload succeeds, so a crash keeps the intent.
  function appToken() {
    try {
      return readFileSync(join(currentPaths().stateDir, 'app-token'), 'utf8').trim();
    } catch {
      return '';
    }
  }

  async function ackRestart(id) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      if (!readyUrl) return false;
      try {
        const response = await fetch(`${readyUrl}/api/app/rsi/restart-ack`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-graph-app-token': appToken(), origin: readyUrl },
          body: JSON.stringify({ id }),
        });
        if (response.ok && (await response.json()).cleared === true) return true;
      } catch {
        // daemon still starting up; retry
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return false;
  }

  function pollRsi() {
    if (!readyUrl || rsiRestarting) return;
    void fetch(`${readyUrl}/api/app/rsi/status`, {
      headers: { 'x-graph-app-token': appToken(), origin: readyUrl },
    })
      .then(async response => (response.ok ? response.json() : null))
      .then(status => {
        const pending = rsiRestartDecision(status, rsiRestarting);
        if (!pending) return;
        rsiRestarting = true;
        void restartDaemon()
          .then(async url => {
            const cleared = await ackRestart(pending.id);
            if (!cleared) console.warn('[app] rsi restart applied but the request was not acknowledged');
            if (window) showConsole(url);
          })
          .catch(error => console.warn('[app] rsi restart failed', error))
          .finally(() => { rsiRestarting = false; });
      })
      .catch(() => undefined);
  }

  function refreshTray() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(openQuestionTotal, crashLabel(lastCrash)).map(item => {
      if (item.separator) return { type: 'separator' };
      if (item.action === 'open') {
        return { label: item.label, click: () => { if (window) { window.show(); window.focus(); } else if (readyUrl) openWindow(readyUrl); } };
      }
      if (item.action === 'open-crash') {
        return {
          label: item.label,
          click: () => {
            const target = lastCrash?.ips ?? run.recordPath;
            if (verbose) console.log(`[app] opening the record of the last crash: ${target}`);
            if (!background) void shell.openPath(target);
          },
        };
      }
      if (item.action === 'quit') return { label: item.label, click: () => app.quit() };
      return { label: item.label, enabled: item.enabled ?? true };
    })));
  }

  function createTray() {
    if (background || tray) return;
    const iconPath = trayIconPath(currentPaths().root);
    if (!existsSync(iconPath)) return;
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Graph');
    if (verbose) console.log('[app] tray ready');
    tray.on('click', () => { if (window) { window.show(); window.focus(); } else if (readyUrl) openWindow(readyUrl); });
    refreshTray();
  }

  function stopDaemon() {
    return daemon.stop();
  }

  app.on('second-instance', () => {
    if (background) return;
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    if (readyUrl) openWindow(readyUrl);
  });

  app.on('activate', () => {
    if (background) return;
    if (!window && readyUrl) openWindow(readyUrl);
  });

  app.on('window-all-closed', () => {
    // The daemon keeps running when the window closes; reopen via the dock.
  });

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      // A stop signal is a normal exit: the app stops its daemon and removes
      // its run marker, so the next launch owes nobody an apology and the
      // keeper sees exit code 0 and stays down.
      if (quitting) return;
      if (!app.isReady()) {
        run.removeMarker();
        app.exit(0);
        return;
      }
      app.quit();
    });
  }

  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    run.removeMarker();
    clearInterval(taskPoll);
    clearInterval(rsiPoll);
    clearInterval(secretPoll);
    void Promise.race([stopDaemon(), new Promise(resolveStop => setTimeout(resolveStop, 7_000))]).then(() => app.exit(0));
  });

  void app.whenReady().then(() => {
    if (background) app.dock?.hide();
    registerBridge();
    createTray();
    if (lastCrash) {
      console.warn(`[app] ${crashLabel(lastCrash)} — ${lastCrash.reason}`);
      if (!background && Notification.isSupported()) {
        new Notification({ title: crashLabel(lastCrash) ?? 'Graph', body: lastCrash.reason }).show();
      }
    }
    startDaemon();
    taskPoll = setInterval(pollTasks, 4_000);
    rsiPoll = setInterval(pollRsi, 5_000);
    // One interval for the whole app run: a restart only changes `readyUrl`, and
    // a second interval per restart would leak one poll per reload.
    secretPoll = setInterval(() => { void pollSecretRequests(); }, 1_500);
  });
}
