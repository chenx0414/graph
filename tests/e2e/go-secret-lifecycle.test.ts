import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The privileged secret bridge.
 *
 * The browser may never hold a secret, and the keychain may only be written
 * by the desktop app. So the bridge sits between them: the daemon keeps the
 * write the host asked for, the desktop app fetches it, stores it, and
 * confirms. The latest write is the one that counts, a confirmation that
 * arrives late never becomes a fresh credential change, and a key the user
 * just logged out of does not come back because an old writer finished.
 *
 * The proof is the real daemon over real HTTP: the bridge token is read from
 * the state directory the daemon wrote it to.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

/** Whether the configuration says the local credential is really there. */
function credentialConfigured(body: unknown): boolean | undefined {
  const view = body as { config?: { credentials?: Record<string, { configured?: boolean }> } };
  return view.config?.credentials?.local?.configured;
}

test('the privileged secret bridge keeps the latest pending write until the desktop confirms it, and shows the browser no value', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-secret-lifecycle-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_KEYCHAIN_ONLY: 'synthetic-keychain-only' } });
  cleanup.push(() => daemon.close());

  // The bridge token is written to the state directory; the browser never has it.
  const token = (await readFile(join(root, 'state', 'app-token'), 'utf8')).trim();
  expect(token).not.toBe('');

  const bridge = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, { ...init, headers: { 'x-graph-app-token': token } });
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const browser = async (path: string) => {
    const response = await daemon.request(path);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const pending = async () => (await bridge('/api/app/secret-requests')).body as { requests: { ref: string; value: string | null }[] };
  const push = async (ref: string, value: string | null, persisted = false) => {
    const result = await bridge('/api/app/secret', {
      method: 'POST', body: JSON.stringify({ ref, value, persisted }),
    });
    expect(result.status, JSON.stringify(result.body)).toBe(200);
    return result.body as { applied: boolean; reason?: string };
  };

  // The browser has a session, but the bridge is not for the browser.
  expect((await browser('/api/app/secret-requests')).status).toBe(403);
  expect((await pending()).requests).toEqual([]);

  // A write the host asked for waits for the desktop to store it.
  expect((await push('GRAPH_LOCAL_KEY', 'synthetic-first')).applied).toBe(true);
  expect((await pending()).requests).toEqual([{ ref: 'GRAPH_LOCAL_KEY', value: 'synthetic-first' }]);

  // The latest write is the one that counts.
  expect((await push('GRAPH_LOCAL_KEY', 'synthetic-last')).applied).toBe(true);
  expect((await pending()).requests).toEqual([{ ref: 'GRAPH_LOCAL_KEY', value: 'synthetic-last' }]);

  // The desktop can finish an earlier disk write after a newer host update.
  // That confirmation is stale: it changes nothing, and the newer value stays
  // pending.
  const stale = await push('GRAPH_LOCAL_KEY', 'synthetic-first', true);
  expect(stale.applied).toBe(false);
  expect(stale.reason).toContain('持久化确认已过期');
  expect((await pending()).requests).toEqual([{ ref: 'GRAPH_LOCAL_KEY', value: 'synthetic-last' }]);

  // The browser sees that a secret is pending, and never its value.
  const config = await browser('/api/config');
  expect(config.status).toBe(200);
  const view = config.body as {
    pendingSecretRefs: string[];
    config: { skills: { sedimentation: unknown }; credentials: Record<string, { secretRef: string; configured: boolean }> };
  };
  expect(view.pendingSecretRefs).toEqual(['GRAPH_LOCAL_KEY']);
  expect(view.config.skills.sedimentation).toEqual({ enabled: false, afterToolCalls: 10, model: null, budgetTokens: 40000 });
  expect(view.config.credentials.local).toMatchObject({ secretRef: 'GRAPH_LOCAL_KEY', configured: true });
  expect(JSON.stringify(config.body)).not.toContain('synthetic-last');
  expect(await readFile(configPath, 'utf8')).not.toContain('synthetic-last');

  // The desktop confirms the value it stored: nothing is pending any more.
  expect((await push('GRAPH_LOCAL_KEY', 'synthetic-last', true)).applied).toBe(true);
  expect((await pending()).requests).toEqual([]);

  // A logout is a deletion, and it waits for the desktop too.
  expect((await push('GRAPH_LOCAL_KEY', null)).applied).toBe(true);
  expect((await pending()).requests).toEqual([{ ref: 'GRAPH_LOCAL_KEY', value: null }]);
  const afterLogout = await browser('/api/config');
  expect(credentialConfigured(afterLogout.body)).toBe(false);
  expect((await push('GRAPH_LOCAL_KEY', null, true)).applied).toBe(true);
  expect((await pending()).requests).toEqual([]);

  // A delayed acknowledgement must not resurrect a key the user logged out of.
  // The stale writer may still have saved it to disk, so the deletion is queued
  // again instead of the key coming back.
  const late = await push('GRAPH_LOCAL_KEY', 'synthetic-last', true);
  expect(late.applied).toBe(false);
  expect((await pending()).requests).toEqual([{ ref: 'GRAPH_LOCAL_KEY', value: null }]);
  const stillGone = await browser('/api/config');
  expect(credentialConfigured(stillGone.body)).toBe(false);
  expect((await push('GRAPH_LOCAL_KEY', null, true)).applied).toBe(true);
  expect((await pending()).requests).toEqual([]);

  // A ref nothing declares is not queued for the desktop either.
  await push('GRAPH_UNKNOWN_REF', 'synthetic-already-persisted', true);
  expect((await pending()).requests).toEqual([]);
  expect((await browser('/api/config')).body as { pendingSecretRefs: string[] }).toMatchObject({ pendingSecretRefs: [] });
  expect(JSON.stringify(await pending())).not.toContain('GRAPH_KEYCHAIN_ONLY');
}, 120_000);
