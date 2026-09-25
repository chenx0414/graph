/**
 * Electron main process for the Graph desktop app.
 *
 * The app owns the daemon lifecycle: it starts the existing CLI daemon as a
 * Node child process (ELECTRON_RUN_AS_NODE keeps the runtime identical), waits
 * for the loopback address on stdout, and loads the console into a window.
 * Secrets never enter the config file: they are decrypted from the keychain
 * into the child process environment only.
 */
import { app, BrowserWindow, Menu, Notification, Tray, dialog, ipcMain, nativeImage, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { stopDaemonProcess } from './daemon-process.ts';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absolutePaths, appRootFilePath, applySecretRequest, daemonArgs, ensureConfigFile, isLoopbackUrl, loadRawSecretEntries, loadSecrets,
  parseBannerAddress, resolveAppPaths, resolveSourceRoot, resourceDirectory, rsiRestartDecision, saveSecrets, tailText,
  taskNotifications, trayIconPath, trayMenuItems,
} from './lib.ts';

app.setName('Graph');
if (process.env.GRAPH_APP_USER_DATA) app.setPath('userData', resolve(process.env.GRAPH_APP_USER_DATA));
const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const withDevTools = process.argv.includes('--dev');
const verbose = withDevTools || Boolean(process.env.GRAPH_APP_DEBUG);
const smoke = Boolean(process.env.GRAPH_APP_SMOKE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  let child = null;
  let quitting = false;
  let restarting = false;
  let readyUrl = null;
  let pendingReady = null;
  let secrets = {};
  let secretsPath = null;
  let stdout = '';
  let stderr = '';
  let smokeLogged = false;
  let notificationState = { primed: false, questions: {}, status: {} };
  let taskPoll = null;
  let secretPoll = null;
  let rsiPoll = null;
  let rsiRestarting = false;
  let tray = null;
  let openQuestionTotal = 0;

  const readJson = path => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  };

  function openWindow(url) {
    window = new BrowserWindow({
      width: 1320, height: 880, show: false, title: 'Graph',
      backgroundColor: '#0b1020',
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 14, y: 16 },
      webPreferences: {
        contextIsolation: true, nodeIntegration: false, sandbox: true,
        preload: join(devRoot, 'desktop/preload.cjs'),
      },
    });
    window.on('ready-to-show', () => {
      window.show();
      if (withDevTools) window.webContents.openDevTools({ mode: 'detach' });
      if (smoke && !smokeLogged) {
        smokeLogged = true;
        process.stdout.write(`APP_SMOKE_OK ${url}\n`);
      }
    });
    window.webContents.on('did-finish-load', () => {
      if (smoke) setTimeout(() => app.quit(), 600);
    });
    window.webContents.on('will-navigate', (event, target) => {
      if (!isLoopbackUrl(target)) event.preventDefault();
    });
    window.webContents.setWindowOpenHandler(({ url: target }) => {
      if (isLoopbackUrl(target)) return { action: 'allow' };
      void shell.openExternal(target);
      return { action: 'deny' };
    });
    window.on('closed', () => {
      if (verbose) console.log('[app] window closed');
      window = null;
    });
    window.webContents.on('did-start-navigation', (_event, target) => {
      if (verbose) console.log(`[app] nav start ${target}`);
    });
    window.webContents.on('did-fail-load', (_event, code, description, target) => {
      if (verbose) console.log(`[app] nav fail ${code} ${description} ${target}`);
    });
    window.webContents.on('render-process-gone', (_event, details) => {
      if (verbose) console.log(`[app] renderer gone ${details.reason}`);
    });
    void window.loadURL(url);
  }

  function secretsFromKeychain(paths) {
    const codec = {
      isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
      encryptString: value => safeStorage.encryptString(value),
      decryptString: value => safeStorage.decryptString(value),
    };
    return loadSecrets(paths.secretsPath, codec, path => readFileSync(path, 'utf8'));
  }

  function currentPaths() {
    // The app runs the checkout named by the app root file: it is the product line, and it is also
    // the tree a self-improvement change edits and `app:build` rebuilds, so a build can never drop
    // a product feature. The file is the durable setting because a launch from Finder carries no
    // environment; GRAPH_RSI_ROOT stays the override for a dev run.
    const appPath = app.isPackaged ? app.getAppPath() : devRoot;
    const base = resolveAppPaths({ appPath, isPackaged: app.isPackaged, userData: app.getPath('userData') });
    const rootFile = appRootFilePath(base.graphHome);
    const fileRoot = existsSync(rootFile) ? readFileSync(rootFile, 'utf8') : undefined;
    const sourceRoot = resolveSourceRoot({
      fileRoot,
      envRoot: process.env.GRAPH_RSI_ROOT,
      // Only redirect to a checkout that can actually serve the console, so a
      // half-prepared checkout cannot leave the app with a blank window.
      canServe: root => existsSync(join(root, 'src/server/cli.ts')) && existsSync(join(root, 'dist/web/index.html')),
    });
    return absolutePaths(sourceRoot
      ? resolveAppPaths({ appPath, isPackaged: app.isPackaged, userData: app.getPath('userData'), sourceRoot })
      : base);
  }

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
        const codec = {
          isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
          encryptString: input => safeStorage.encryptString(input),
          decryptString: input => safeStorage.decryptString(input),
        };
        // Read-modify-write: an entry this instance cannot decrypt is still the
        // user's entry, and rewriting the file from the in-memory map would erase it.
        const stored = saveSecrets(secretsPath, codec, outcome.secrets, (path, data) => writeFileSync(path, data, { mode: 0o600 }), {
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

  function startDaemon() {
    const paths = currentPaths();
    mkdirSync(paths.stateDir, { recursive: true });
    mkdirSync(dirname(paths.configPath), { recursive: true });
    const hasConfig = ensureConfigFile(paths.configPath, existsSync, (path, data) => writeFileSync(path, data, { mode: 0o600 }));
    const config = hasConfig ? readJson(paths.configPath) : undefined;
    secrets = secretsFromKeychain(paths);
    secretsPath = paths.secretsPath;
    // The APP always starts with execute intent in dynamic mode; saved secrets
    // and config activate the bindings on the same daemon without a restart.
    const args = daemonArgs({ paths, port: 0, mode: 'execute', hasConfig, dynamic: true });
    // Sandboxed helpers cannot start the Electron binary (no Helper apps), so
    // the packaged app ships a real node and points every helper at it.
    const bundledNode = join(paths.root, 'runtime/node');
    const startedChild = spawn(process.execPath, [paths.serverEntry, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...(existsSync(bundledNode) ? { GRAPH_APP_NODE: bundledNode } : {}), ...secrets },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = startedChild;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (child !== startedChild) return;
      stdout += chunk;
      if (verbose) process.stdout.write(chunk);
      if (!readyUrl) {
        const url = parseBannerAddress(stdout);
        if (url) {
          readyUrl = url;
          if (pendingReady) {
            const ready = pendingReady;
            pendingReady = null;
            ready.resolve(url);
          } else if (window) {
            void window.loadURL(url);
          } else {
            openWindow(url);
          }
        }
      }
    });
    child.stderr.on('data', chunk => {
      if (child !== startedChild) return;
      stderr += chunk;
      if (verbose) process.stderr.write(chunk);
    });
    child.on('exit', (code, signal) => {
      if (child !== startedChild) return;
      if (quitting || restarting) {
        if (pendingReady) {
          const rejectReady = pendingReady.reject;
          pendingReady = null;
          rejectReady(new Error(`daemon stopped during restart (exit ${code ?? signal})`));
        }
        return;
      }
      if (!readyUrl) {
        dialog.showErrorBox('Graph daemon failed to start', tailText(stderr || stdout, 12) || `exit ${code ?? signal}`);
        app.quit();
        return;
      }
      dialog.showErrorBox('Graph daemon stopped', `exit ${code ?? signal}\n${tailText(stderr, 8)}`);
      app.quit();
    });
  }

  function restartDaemon() {
    restarting = true;
    return new Promise((resolveReady, rejectReady) => {
      void stopDaemon().then(() => {
        readyUrl = null;
        stdout = '';
        stderr = '';
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
    ipcMain.handle('graph:pick-directory', async () => {
      const result = await dialog.showOpenDialog(window ?? undefined, { properties: ['openDirectory', 'createDirectory'] });
      return result.canceled ? null : result.filePaths[0] ?? null;
    });
    ipcMain.handle('graph:open-resource', async (_event, kind) => {
      if (kind !== 'skills' && kind !== 'mcp' && kind !== 'pi-extensions' && kind !== 'agent-md' && kind !== 'prompts') {
        return { opened: false, message: 'unknown resource library' };
      }
      const path = resourceDirectory(currentPaths().graphHome, kind);
      mkdirSync(path, { recursive: true });
      const message = await shell.openPath(path);
      return message ? { opened: false, path, message } : { opened: true, path };
    });
    ipcMain.handle('graph:save-secret', async (_event, ref, value) => {
      const request = applySecretRequest(secrets, ref, value);
      if (!request.ok) return { stored: false, applied: false, message: request.message };
      if (!secretsPath) return { stored: false, applied: false, message: 'no secrets path' };
      const codec = {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: input => safeStorage.encryptString(input),
        decryptString: input => safeStorage.decryptString(input),
      };
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
    if (window.isMinimized()) window.restore();
    window.focus();
    void window.webContents.executeJavaScript(`location.hash = ${JSON.stringify(`#/tasks/${taskId}`)}`).catch(() => undefined);
  }

  function notifyDecision(decision) {
    if (!Notification.isSupported()) return;
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
            if (window) void window.loadURL(url);
          })
          .catch(error => console.warn('[app] rsi restart failed', error))
          .finally(() => { rsiRestarting = false; });
      })
      .catch(() => undefined);
  }

  function refreshTray() {
    if (!tray) return;
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuItems(openQuestionTotal).map(item => {
      if (item.separator) return { type: 'separator' };
      if (item.action === 'open') {
        return { label: item.label, click: () => { if (window) { window.show(); window.focus(); } else if (readyUrl) openWindow(readyUrl); } };
      }
      if (item.action === 'quit') return { label: item.label, click: () => app.quit() };
      return { label: item.label, enabled: item.enabled ?? true };
    })));
  }

  function createTray() {
    if (tray) return;
    const iconPath = trayIconPath(currentPaths().root);
    if (!existsSync(iconPath)) return;
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Graph');
    if (verbose) console.log('[app] tray ready');
    tray.on('click', () => { if (window) { window.show(); window.focus(); } else if (readyUrl) openWindow(readyUrl); });
    refreshTray();
  }

  function stopDaemon() {
    return stopDaemonProcess(child);
  }

  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
      return;
    }
    if (readyUrl) openWindow(readyUrl);
  });

  app.on('activate', () => {
    if (!window && readyUrl) openWindow(readyUrl);
  });

  app.on('window-all-closed', () => {
    // The daemon keeps running when the window closes; reopen via the dock.
  });

  app.on('before-quit', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    clearInterval(taskPoll);
    clearInterval(rsiPoll);
    clearInterval(secretPoll);
    void Promise.race([stopDaemon(), new Promise(resolveStop => setTimeout(resolveStop, 7_000))]).then(() => app.exit(0));
  });

  void app.whenReady().then(() => {
    registerBridge();
    createTray();
    startDaemon();
    taskPoll = setInterval(pollTasks, 4_000);
    rsiPoll = setInterval(pollRsi, 5_000);
    // One interval for the whole app run: a restart only changes `readyUrl`, and
    // a second interval per restart would leak one poll per reload.
    secretPoll = setInterval(() => { void pollSecretRequests(); }, 1_500);
  });
}
