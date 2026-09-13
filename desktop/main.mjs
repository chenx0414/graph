/**
 * Electron main process for the Graph desktop app.
 *
 * The app owns the daemon lifecycle: it starts the existing CLI daemon as a
 * Node child process (ELECTRON_RUN_AS_NODE keeps the runtime identical), waits
 * for the loopback address on stdout, and loads the console into a window.
 * Secrets never enter the config file: they are decrypted from the keychain
 * into the child process environment only.
 */
import { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absolutePaths, daemonArgs, ensureConfigFile, isLoopbackUrl, loadSecrets,
  parseBannerAddress, resolveAppPaths, resolveDaemonMode, saveSecrets, tailText,
  taskNotifications,
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

  const readJson = path => {
    try {
      return JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return undefined;
    }
  };

  function openWindow(url) {
    window = new BrowserWindow({
      width: 1280, height: 860, show: false, title: 'Graph',
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

  function startDaemon() {
    const paths = absolutePaths(resolveAppPaths({
      appPath: devRoot,
      resourcesPath: process.resourcesPath,
      isPackaged: app.isPackaged,
      userData: app.getPath('userData'),
    }));
    mkdirSync(paths.stateDir, { recursive: true });
    mkdirSync(dirname(paths.configPath), { recursive: true });
    const hasConfig = ensureConfigFile(paths.configPath, existsSync, (path, data) => writeFileSync(path, data, { mode: 0o600 }));
    const config = hasConfig ? readJson(paths.configPath) : undefined;
    secrets = secretsFromKeychain(paths);
    secretsPath = paths.secretsPath;
    const mode = resolveDaemonMode(config, process.env, secrets);
    const args = daemonArgs({ paths, port: 0, mode, hasConfig });
    child = spawn(process.execPath, [paths.serverEntry, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...secrets },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
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
      stderr += chunk;
      if (verbose) process.stderr.write(chunk);
    });
    child.on('exit', (code, signal) => {
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
    ipcMain.handle('graph:save-secret', (_event, ref, value) => {
      if (typeof ref !== 'string' || typeof value !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref) || !value.trim()) {
        return { stored: false, message: 'invalid secret reference or empty value' };
      }
      if (!secretsPath) return { stored: false, message: 'no secrets path' };
      const codec = {
        isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
        encryptString: input => safeStorage.encryptString(input),
        decryptString: input => safeStorage.decryptString(input),
      };
      secrets[ref] = value.trim();
      const stored = saveSecrets(secretsPath, codec, secrets, (path, data) => writeFileSync(path, data, { mode: 0o600 }));
      return { stored, ...(stored ? {} : { message: 'encryption unavailable; use the environment variable instead' }) };
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
      })
      .catch(() => undefined);
  }

  function stopDaemon() {
    return new Promise(resolveStop => {
      if (!child || child.exitCode !== null) return resolveStop();
      const done = () => resolveStop();
      child.once('exit', done);
      child.kill('SIGTERM');
      setTimeout(() => {
        if (child && child.exitCode === null) child.kill('SIGKILL');
      }, 5_000);
    });
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
    void Promise.race([stopDaemon(), new Promise(resolveStop => setTimeout(resolveStop, 7_000))]).then(() => app.exit(0));
  });

  void app.whenReady().then(() => {
    registerBridge();
    startDaemon();
    taskPoll = setInterval(pollTasks, 4_000);
  });
}
