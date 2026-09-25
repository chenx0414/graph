import { expect, test } from 'vitest';
import { mcpAdapterServerDefinition, mcpAdapterServerName } from '../../src/runtime/mcp-adapter-server.ts';

test('a stdio declaration becomes a minimal-environment command server', () => {
  const definition = mcpAdapterServerDefinition({
    command: 'node',
    args: ['./node_modules/server/dist/index.js'],
    env: { GITHUB_TOKEN: '${GH_TOKEN}', MODE: 'stdio' },
  }, { GH_TOKEN: 'secret-value' });
  expect(definition).toEqual({
    command: 'node',
    args: ['./node_modules/server/dist/index.js'],
    env: { GITHUB_TOKEN: 'secret-value', MODE: 'stdio' },
    inheritEnv: false,
  });
});

test('a remote declaration keeps literals and resolves headersEnv from secrets', () => {
  const definition = mcpAdapterServerDefinition({
    url: 'https://mcp.example.com/mcp',
    headers: { 'X-Trace': 'graph' },
    headersEnv: { Authorization: 'MCP_TOKEN' },
  }, { MCP_TOKEN: 'Bearer abc' });
  expect(definition).toEqual({
    url: 'https://mcp.example.com/mcp',
    headers: { 'X-Trace': 'graph', Authorization: 'Bearer abc' },
  });
});

test('an env value starting with a bang is escaped because the adapter would run it as a command', () => {
  const definition = mcpAdapterServerDefinition({ command: 'node', args: [], env: { NOTICE: '!important' } });
  expect(definition?.env).toEqual({ NOTICE: '!!important' });
});

test('a declaration with neither url nor command is not registrable', () => {
  expect(mcpAdapterServerDefinition({}, {})).toBeUndefined();
  expect(mcpAdapterServerDefinition({ args: ['x'] }, {})).toBeUndefined();
});

test('a missing environment variable fails loudly instead of registering an empty credential', () => {
  expect(() => mcpAdapterServerDefinition({ command: 'node', args: [], env: { TOKEN: '${ABSENT_TOKEN}' } }, {})).toThrow(/ABSENT_TOKEN/);
  expect(() => mcpAdapterServerDefinition({ url: 'https://mcp.example.com/mcp', headersEnv: { Authorization: 'ABSENT_TOKEN' } }, {})).toThrow(/ABSENT_TOKEN/);
});

test('a non-http remote url is refused', () => {
  expect(() => mcpAdapterServerDefinition({ url: 'file:///tmp/mcp.sock' }, {})).toThrow(/http/);
});

test('the server name is the capability id unchanged', () => {
  expect(mcpAdapterServerName('cloudflare-docs')).toBe('cloudflare-docs');
  expect(mcpAdapterServerName('@scope/pkg')).toBe('@scope/pkg');
});
