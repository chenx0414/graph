import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const offline = process.env.UV_OFFLINE === '1' || process.env.npm_config_offline === 'true';

if (process.env.UV_CACHE_DIR) {
  await mkdir(process.env.UV_CACHE_DIR, { recursive: true });
  await appendFile(join(process.env.UV_CACHE_DIR, 'phases.log'), `${offline ? 'runtime' : 'provision'}\n`);
}

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
};

const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  if (!line.trim()) return;
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') return;
  if (request.method === 'initialize') {
    reply(request.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'provisioning-fixture', version: '1.0.0' },
    });
    return;
  }
  if (request.method === 'tools/list') {
    let network = 'not-probed';
    if (process.env.MCP_PROVISION_PROBE_URL) {
      try {
        await fetch(process.env.MCP_PROVISION_PROBE_URL);
        network = 'open';
      } catch {
        network = 'blocked';
      }
    }
    reply(request.id, {
      tools: [{
        name: `${offline ? 'runtime' : 'provision'}_network_${network}`,
        description: 'Reports the active provisioning phase and network result.',
        inputSchema: { type: 'object', properties: {} },
      }],
    });
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { message: 'unsupported' } })}\n`);
});
