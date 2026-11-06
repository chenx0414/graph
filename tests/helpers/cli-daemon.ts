import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';
import { findGraphd, graphdSearchStarts } from '../../src/server/go-launch.ts';
import { ensureBackendBinary } from './backend-binary.ts';

/** Real executable, real loopback HTTP and an isolated caller-owned state directory. */
export async function launchCli(root: string, options: {
  sourceRoot?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  /** Own directories when the caller already has them (a built console, a kept state dir). */
  stateDir?: string;
  graphHome?: string;
  webDir?: string;
  /** Pin the port. Zero asks the operating system for a free one. */
  port?: number;
} = {}) {
  const sourceRoot = options.sourceRoot ?? process.cwd();
  // A checkout that never built the backend would fail every assertion for a
  // reason that has nothing to do with the code under test.
  if (!process.env.GRAPH_DAEMON_BIN) ensureBackendBinary();
  const bin = findGraphd([process.cwd(), sourceRoot, ...graphdSearchStarts()]);
  const args = [
    '--state-dir', options.stateDir ?? join(root, 'state'),
    '--graph-home', options.graphHome ?? join(root, 'graph-home'),
    '--web-dir', options.webDir ?? join(root, 'web'),
    '--port', String(options.port ?? 0),
    '--application-root', resolve(sourceRoot),
    ...(options.configPath ? ['--config', options.configPath] : []),
    ...options.extraArgs ?? [],
  ];
  process.stdout.write(`[graph] backend ${bin}\n`);
  // The daemon inherits this process' environment. That is what makes a test
  // see the flags and keys it set for itself - and also what makes a test
  // depend on the machine: an ambient GRAPH_SUBSCRIPTION_* key makes a
  // subscription platform look configured, so a case that asserts "saving
  // without a key is refused" passes on a clean laptop and fails here
  // (measured: provider-metadata.part-02). A case that needs an unresolved
  // credential must pass that variable empty rather than trust the host.
  const child = spawn(bin, args, {
    cwd: root, env: { ...process.env, HOME: root, ...options.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr += chunk; });
  const exit = once(child, 'exit');
  const ready = new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error(`CLI failed to start\n${stdout}\n${stderr}`)), 20000);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const address = /address:\s+(http:\/\/127\.0\.0\.1:\d+)/.exec(stdout);
      if (address) { clearTimeout(timer); resolveUrl(address[1]!); }
    });
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`CLI exited before startup (${code ?? signal})\n${stdout}\n${stderr}`));
    });
  });
  let url: string;
  try { url = await ready; }
  catch (error) {
    child.kill('SIGKILL');
    await exit.catch(() => undefined);
    throw error;
  }
  const home = await fetch(url);
  const headers = { origin: url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  return {
    url, child,
    get stdout() { return stdout; },
    get stderr() { return stderr; },
    request(path: string, init: RequestInit = {}) {
      // A daemon that accepted the connection and never answered used to hang the
      // caller until vitest's own test timeout, which names no request and hides
      // whether the product stalled or the test waited forever. Bound every call
      // and name the path that did not answer.
      return fetch(`${url}${path}`, { signal: init.signal ?? AbortSignal.timeout(60_000), ...init, headers: { ...headers, ...init.headers } })
        .catch(error => {
          if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
            throw new Error(`The daemon did not answer ${path} within 60s`, { cause: error });
          }
          throw error;
        });
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const timer = setTimeout(() => child.kill('SIGKILL'), 7000);
      child.kill('SIGTERM');
      try { await exit; }
      finally { clearTimeout(timer); }
    },
  };
}
