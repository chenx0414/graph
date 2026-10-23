import { app, BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import { consoleRoute, isLoopbackUrl } from './lib.ts';

let smokeLogged = false;

export function createConsoleWindow({ url, devRoot, withDevTools, verbose, smoke, background, onRoute, onClosed }) {
  const window = new BrowserWindow({
    width: 1320, height: 880, show: false, title: 'Graph',
    backgroundColor: '#0b1020',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 16 },
    ...(background ? { focusable: false, skipTaskbar: true } : {}),
    webPreferences: {
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: !background,
      preload: join(devRoot, 'desktop/preload.cjs'),
    },
  });
  window.webContents.on('before-input-event', (_event, input) => {
    const shortcut = (input.meta || input.control) && !input.alt && !input.shift
      && /^(w|[1-9])$/i.test(input.key);
    const settings = /#\/(settings|setup)(?:[?/#]|$)/.test(window.webContents.getURL());
    window.webContents.setIgnoreMenuShortcuts(shortcut && !settings);
  });
  window.webContents.on('did-navigate-in-page', (_event, target, isMainFrame) => {
    if (!isMainFrame) return;
    const route = consoleRoute(target);
    if (route) onRoute(route);
  });
  window.on('ready-to-show', () => {
    if (!background) {
      window.show();
      if (withDevTools) window.webContents.openDevTools({ mode: 'detach' });
    }
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
    if (isLoopbackUrl(target)) {
      return { action: 'allow', overrideBrowserWindowOptions: {
        ...(background ? { show: false, focusable: false, skipTaskbar: true } : {}),
        webPreferences: { backgroundThrottling: !background },
      } };
    }
    if (!background) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.on('closed', () => {
    if (verbose) console.log('[app] window closed');
    onClosed();
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
  return window;
}

export function reportDaemonError(title, message, background) {
  if (background) console.error(`[app] ${title}: ${message}`);
  else dialog.showErrorBox(title, message);
}
