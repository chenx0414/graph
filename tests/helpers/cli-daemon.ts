import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join, resolve } from 'node:path';

/** Real executable, real loopback HTTP and an isolated caller-owned state directory. */
export async function launchCli(root: string, options: {
  sourceRoot?: string;
  configPath?: string;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
} = {}) {
  const sourceRoot = options.sourceRoot ?? process.cwd();
  const args = [
    resolve(sourceRoot, 'src/server/cli.ts'),
    '--state-dir', join(root, 'state'), '--graph-home', join(root, 'graph-home'),
    '--web-dir', join(root, 'web'), '--port', '0',
    ...(options.configPath ? ['--config', options.configPath] : []),
    ...options.extraArgs ?? [],
  ];
  const child = spawn(process.execPath, args, {
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
      return fetch(`${url}${path}`, { ...init, headers: { ...headers, ...init.headers } });
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
