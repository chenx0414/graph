/**
 * Drive the shipped Go backend from a script.
 *
 * The backend is one process: the `graphd` binary. The repository launcher
 * (`src/server/cli.ts`) is the supported way to start it, so a script here
 * starts the same daemon a user starts - not an in-process runtime.
 *
 * Everything a script needs is on the daemon's HTTP surface. Reading the
 * console's own state through an internal API would bind the script to an
 * implementation that no longer exists; the public routes are the contract.
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');

/**
 * Start the daemon and wait until it reports the address it is listening on.
 *
 * The daemon publishes that address on its own stdout once the socket is
 * bound, and writes the same record into its state directory.
 */
export async function startGoDaemon({
  root,
  configPath,
  stateDir,
  graphHome,
  mode = 'execute',
  env = {},
  extraArgs = [],
}) {
  const binary = join(repo, 'dist/graphd');
  if (!existsSync(binary)) {
    const build = spawnSync('go', ['-C', join(repo, 'backend'), 'run', './cmd/graphbuild', 'backend'], { stdio: 'inherit' });
    if (build.status !== 0) throw new Error('the daemon binary is missing and could not be built');
  }
  const args = [
    binary,
    '--application-root', repo,
    '--state-dir', stateDir,
    '--graph-home', graphHome,
    '--port', '0',
    mode === 'execute' ? '--execute' : '--view-only',
    ...(configPath ? ['--config', configPath] : []),
    ...extraArgs,
  ];
  const child = spawn(binary, args.slice(1), {
    cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  const exit = once(child, 'exit');
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`The daemon did not report an address\n${stdout}\n${stderr}`)), 30_000);
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const address = /address:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (address) { clearTimeout(timer); resolveUrl(address[1]); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`The daemon exited before startup (${code ?? signal})\n${stdout}\n${stderr}`));
    });
  });
  return {
    url,
    child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.kill('SIGTERM');
      try { await exit; }
      finally { clearTimeout(timer); }
    },
  };
}

/**
 * A client for the daemon's public HTTP surface.
 *
 * The console is a browser client: it proves who it is with the session
 * cookie the daemon hands out on the home page. Every call here carries that
 * cookie and the matching origin, exactly like the console does.
 */
export async function openConsole(url) {
  const home = await fetch(url);
  const headers = {
    origin: url,
    cookie: home.headers.get('set-cookie') ?? '',
    'content-type': 'application/json',
  };
  const request = async (path, init = {}) => {
    const response = await fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); }
      catch { body = text; }
    }
    return { status: response.status, body };
  };
  return {
    url,
    headers,
    request,
    /** Read one endpoint, or fail loudly with what the daemon actually said. */
    async json(path, init = {}) {
      const { status, body } = await request(path, init);
      if (status < 200 || status >= 300) {
        throw new Error(`${init.method ?? 'GET'} ${path} -> ${status}: ${JSON.stringify(body).slice(0, 400)}`);
      }
      return body;
    },
    /** Send a JSON body to one endpoint. */
    post(path, body) {
      return this.json(path, { method: 'POST', body: JSON.stringify(body) });
    },
  };
}
