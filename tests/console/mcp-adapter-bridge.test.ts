import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { mcpAdapterServers } from '../../src/runtime/mcp-adapter-bridge.ts';
import { canonicalJson } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function capability(id: string, manifest: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'graph-mcp-adapter-servers-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const path = join(root, id);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'capability.json'), canonicalJson({ id, kind: 'mcp', version: '1.0.0', name: id, ...manifest }));
  return path;
}

test('bound MCP capabilities become adapter servers with resolved secrets', async () => {
  const remote = await capability('cloudflare-docs', { url: 'https://docs.mcp.cloudflare.com/mcp' });
  const local = await capability('github', { command: 'node', args: ['./node_modules/server/index.js'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
  const servers = mcpAdapterServers([
    { id: 'cloudflare-docs', version: '1.0.0', kind: 'mcp', path: remote },
    { id: 'github', version: '1.0.0', kind: 'mcp', path: local },
  ], { GITHUB_TOKEN: 'gh-secret' });
  expect(servers).toEqual([
    { name: 'cloudflare-docs', definition: { url: 'https://docs.mcp.cloudflare.com/mcp' } },
    // The declared arg means "inside the capability": the adapter runs the
    // command from the worker cwd, so passing it through verbatim would launch
    // a path that does not exist there.
    { name: 'github', definition: { command: 'node', args: [join(local, 'node_modules/server/index.js')], env: { GITHUB_TOKEN: 'gh-secret' }, inheritEnv: false } },
  ]);
});

test('only MCP capabilities are registered, and one without transport is skipped', async () => {
  const half = await capability('half', { url: '' });
  const servers = mcpAdapterServers([
    { id: 'half', version: '1.0.0', kind: 'mcp', path: half },
    { id: 'not-mcp', version: '1.0.0', kind: 'pi-extension', path: half },
    { id: 'agent-prompt', version: '1.0.0', kind: 'prompt', path: half, role: 'agent' },
  ], {});
  expect(servers).toEqual([]);
});

test('a missing credential stops the server list instead of registering an empty one', async () => {
  const local = await capability('github', { command: 'node', args: [], env: { GITHUB_TOKEN: '${ABSENT_TOKEN}' } });
  expect(() => mcpAdapterServers([{ id: 'github', version: '1.0.0', kind: 'mcp', path: local }], {}))
    .toThrow(/ABSENT_TOKEN/);
});
