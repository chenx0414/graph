import { app } from 'electron';
import { fileSecretsCodec, secretsKeyPath } from './secrets-codec.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { absolutePaths, appRootFilePath, loadSecrets, resolveAppPaths, resolveSourceRoot } from './lib.ts';

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
 * The name survived the move: the store used to live behind the login keychain,
 * and every touch of that keychain raised a macOS dialog the reader could not get
 * rid of (measured 2026-11-05). A value sealed by the keychain in an earlier
 * version now fails to open and reads as an unconfigured provider - the entry is
 * left in the file, untouched, and the keychain is never opened again.
 */
export function secretsFromKeychain(paths) {
  const codec = fileSecretsCodec(secretsKeyPath(paths.secretsPath));
  return loadSecrets(paths.secretsPath, codec, path => readFileSync(path, 'utf8'));
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
