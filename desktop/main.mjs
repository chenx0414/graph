/**
 * Electron main process for the Graph desktop app.
 *
 * The app owns the daemon lifecycle: it starts the existing CLI daemon as a
 * Node child process (ELECTRON_RUN_AS_NODE keeps the runtime identical), waits
 * for the loopback address on stdout, and loads the console into a window.
 * Secrets never enter the config file: they are decrypted from the keychain
 * into the child process environment only.
 */
import { app, BrowserWindow, dialog, safeStorage, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  absolutePaths, daemonArgs, isLoopbackUrl, loadSecrets, parseBannerAddress,
  resolveAppPaths, resolveDaemonMode, tailText,
} from './lib.ts';

app.setName('Graph');
const devRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const withDevTools = process.argv.includes('--dev');
const smoke = Boolean(process.env.GRAPH_APP_SMOKE);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let window = null;
  let child = null;
  let quitting = false;
  let readyUrl = null;
  let stdout = '';
  let stderr = '';
  let smokeLogged = false;

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
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
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
      window = null;
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
    const config = existsSync(paths.configPath) ? readJson(paths.configPath) : undefined;
    const secrets = secretsFromKeychain(paths);
    const mode = resolveDaemonMode(config, process.env, secrets);
    const args = daemonArgs({ paths, port: 0, mode, hasConfig: config !== undefined });
    child = spawn(process.execPath, [paths.serverEntry, ...args], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...secrets },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
      if (withDevTools) process.stdout.write(chunk);
      if (!readyUrl) {
        const url = parseBannerAddress(stdout);
        if (url) {
          readyUrl = url;
          openWindow(url);
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
      if (withDevTools) process.stderr.write(chunk);
    });
    child.on('exit', (code, signal) => {
      if (quitting) return;
      if (!readyUrl) {
        dialog.showErrorBox('Graph daemon failed to start', tailText(stderr || stdout, 12) || `exit ${code ?? signal}`);
        app.quit();
        return;
      }
      dialog.showErrorBox('Graph daemon stopped', `exit ${code ?? signal}\n${tailText(stderr, 8)}`);
      app.quit();
    });
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
    void Promise.race([stopDaemon(), new Promise(resolveStop => setTimeout(resolveStop, 7_000))]).then(() => app.exit(0));
  });

  void app.whenReady().then(startDaemon);
}
