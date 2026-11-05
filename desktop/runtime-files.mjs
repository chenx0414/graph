import { app, safeStorage } from 'electron';
import { fileSecretsCodec, secretsKeyPath } from './secrets-codec.mjs';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { absolutePaths, appRootFilePath, loadRawSecretEntries, resolveAppPaths, resolveSourceRoot, saveSecrets } from './lib.ts';

export function findPackagedDaemon(sourceRoot, devRoot) {
  if (process.env.GRAPH_DAEMON_BIN && existsSync(process.env.GRAPH_DAEMON_BIN)) return resolve(process.env.GRAPH_DAEMON_BIN);
  const starts = [sourceRoot, devRoot, process.cwd()];
  const seen = new Set();
  for (const start of starts) {
    let dir = resolve(start);
    for (let depth = 0; depth < 12; depth += 1) {
      if (seen.has(dir)) break;
      seen.add(dir);
      const candidate = join(dir, 'dist', 'graphd');
      if (existsSync(candidate)) return candidate;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  throw new Error('dist/graphd is missing. Build backend/cmd/graphd into dist/graphd.');
}

/** The secrets this app has stored, opened with the key file beside them.
 *
 * The store used to live behind the login keychain, and every touch raised a macOS
 * dialog the reader could not get rid of (measured 2026-11-05). One migration is
 * allowed and only one: when there is no key file yet, values are opened with the
 * keychain, immediately re-sealed with the new key, and written back. From then on
 * the keychain is never opened again - and the reader's provider credentials keep
 * working instead of reading as unconfigured.
 */
export function secretsFromKeychain(paths) {
  const keyPath = secretsKeyPath(paths.secretsPath);
  const file = fileSecretsCodec(keyPath);
  let raw;
  try {
    raw = readFileSync(paths.secretsPath, 'utf8');
  } catch {
    return {};
  }
  const entries = (() => {
    try {
      const parsed = JSON.parse(raw);
      return parsed?.entries && typeof parsed.entries === 'object' ? parsed.entries : {};
    } catch {
      return {};
    }
  })();
  const opened = {};
  let migrated = false;
  for (const [ref, value] of Object.entries(entries)) {
    if (typeof value !== 'string') continue;
    const sealed = Buffer.from(value, 'base64');
    try {
      opened[ref] = file.decryptString(sealed);
      continue;
    } catch {
      // Not sealed by this key file: either a first run after the move, or a value
      // the keychain sealed before it.
    }
    try {
      opened[ref] = safeStorage.decryptString(sealed);
      migrated = true;
    } catch {
      // A value nothing on this machine can open stays in the file untouched.
    }
  }
  if (migrated) {
    saveSecrets(paths.secretsPath, file, opened, (path, data) => writeFileSync(path, data, { mode: 0o600 }), {
      raw: loadRawSecretEntries(paths.secretsPath, path => readFileSync(path, 'utf8')),
      touched: Object.keys(opened),
    });
  }
  return opened;
}

export const readJson = path => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
};

export function currentAppPaths(devRoot) {
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
