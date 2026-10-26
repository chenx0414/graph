import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The console that is already open keeps working after the daemon restarts.
 *
 * The browser holds one session cookie for the console. The daemon that
 * serves the console can be replaced under it - the desktop app relaunches it
 * on the same port, an upgrade replaces the binary - and the console must not
 * turn into a wall of "unauthorized" answers because the process behind it
 * changed.
 *
 * The proof is two real daemons over the same state directory on the same
 * port: the second one answers the first one's cookie.
 */

test('the session a console holds survives the daemon being replaced', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-session-'));
  const webDir = join(root, 'web');
  await mkdir(webDir, { recursive: true });
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: root }],
    credentials: { local: { secretRef: 'GRAPH_SESSION_KEY' } },
    models: { entries: [{ id: 'local', provider: 'stub', grade: 'medium', api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 2048, maxTokens: 128, credentialId: 'local' }] },
  }));

  const stateDir = join(root, 'state');
  const first = await launchCli(root, { configPath, stateDir, webDir, env: { GRAPH_SESSION_KEY: 'session-synthetic' } });
  try {
    const home = await fetch(first.url);
    expect(home.status).toBe(200);
    const cookie = home.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('graph_session=');

    const withCookie = async (url: string) => fetch(`${url}/api/config`, { headers: { cookie } });
    const before = await withCookie(first.url);
    expect(before.status).toBe(200);

    // The daemon is replaced on the same port, the way the desktop app
    // relaunches it.
    const port = Number(new URL(first.url).port);
    await first.close();
    const second = await launchCli(root, { configPath, stateDir, webDir, port, env: { GRAPH_SESSION_KEY: 'session-synthetic' } });
    try {
      expect(second.url).toBe(first.url);
      // The console that was open before the restart is still the same
      // console: its cookie is still good.
      const after = await withCookie(second.url);
      expect(after.status).toBe(200);
      expect(await after.json()).toMatchObject({ config: { models: { entries: [{ id: 'local' }] } } });
    } finally {
      await second.close();
    }
  } finally {
    await first.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
