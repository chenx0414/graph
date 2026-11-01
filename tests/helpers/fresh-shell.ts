import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchCli } from './cli-daemon.ts';

/**
 * The console shell fixture both freshness legs share.
 *
 * A rebuilt console reaches the browser only if the browser asks for the shell
 * document again: that document is the one thing that names the bundle, so a
 * client that keeps it keeps loading the old build.
 *
 * The bundle here is only there to be recognisable: its marker text is the
 * build stamp a person would look for in the DOM.
 */
function shellHtml(bundle: string) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>shell</title>
<script type="module" src="/assets/${bundle}"></script></head>
<body><div id="root"></div></body></html>
`;
}

function bundleJs(stamp: string) {
  return `const marker = document.createElement('div');
marker.setAttribute('data-testid', 'bundle-marker');
marker.textContent = '${stamp}';
document.body.appendChild(marker);
`;
}

/** A real daemon on a real loopback socket, with a real web directory. */
export async function freshShell(cleanup: (() => Promise<void>)[]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-fresh-shell-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'web');
  await mkdir(join(webDir, 'assets'), { recursive: true });
  await mkdir(join(root, 'graph-home', 'capabilities'), { recursive: true });
  await writeFile(join(webDir, 'index.html'), shellHtml('bundle-a.js'));
  await writeFile(join(webDir, 'assets', 'bundle-a.js'), bundleJs('a'));
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root }] }));
  const daemon = await launchCli(root, { configPath, webDir });
  cleanup.push(() => daemon.close());
  return { root, webDir, daemon, url: `${daemon.url}/` };
}

/** A rebuild: a new bundle appears and the shell document starts pointing at it. */
export async function rebuild(webDir: string) {
  await writeFile(join(webDir, 'assets', 'bundle-b.js'), bundleJs('b'));
  await writeFile(join(webDir, 'index.html'), shellHtml('bundle-b.js'));
}

export function cacheControl(headers: Headers) {
  return headers.get('cache-control') ?? '';
}
