import { expect, test } from 'vitest';
import { piWorkerConfig } from '../../src/runtime/pi-process.ts';
import type { AgentSessionRequest } from '../../src/runtime/agent-session.ts';

/**
 * The adapter only ever sees the servers a session request carries. Every hop
 * between the capability bundle and the Pi session has to forward them, and a
 * dropped hop is invisible: the session simply starts with an empty adapter.
 */
function request(extra: Record<string, unknown>): AgentSessionRequest {
  return {
    binding: { taskId: 'task', nodeId: 'master', workspace: '/w' },
    workspace: '/w',
    stateDir: '/s',
    model: { id: 'stub', provider: 'stub', api: 'openai' },
    bundleDigest: 'bundle',
    toolPolicyDigest: 'tools',
    runtimePolicyDigest: 'runtime',
    broker: { send: async () => ({ ok: true }) },
    ...extra,
  } as unknown as AgentSessionRequest;
}

const resolved = { workspace: '/w', stateDir: '/s', skillPaths: [], piExtensionPaths: [] };

test('a session request carries its bound MCP servers into the Pi worker config', () => {
  const servers = [{ name: 'context7', definition: { url: 'https://mcp.context7.com/mcp' } }];
  const config = piWorkerConfig(request({ mcpAdapterServers: servers }), resolved);
  expect(config.mcpAdapterServers).toEqual(servers);
});

test('a session request without MCP servers registers nothing instead of an empty server', () => {
  const config = piWorkerConfig(request({}), resolved);
  expect(config.mcpAdapterServers).toBeUndefined();
});
