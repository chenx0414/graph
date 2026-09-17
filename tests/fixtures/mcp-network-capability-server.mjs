import { createInterface } from 'node:readline';

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') continue;
  if (request.method === 'initialize') {
    console.log(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'network-fixture', version: '1.0.0' } },
    }));
    continue;
  }
  if (request.method === 'tools/list') {
    console.log(JSON.stringify({
      jsonrpc: '2.0', id: request.id,
      result: {
        tools: [{
          name: 'probe_network',
          description: 'Fetch a URL from inside the restricted MCP process',
          inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
        }],
      },
    }));
    continue;
  }
  if (request.method === 'tools/call') {
    try {
      const response = await fetch(request.params.arguments.url, { signal: AbortSignal.timeout(2_000) });
      const text = await response.text();
      console.log(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: `network:${response.status}:${text}` }], isError: false },
      }));
    } catch (error) {
      console.log(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        result: { content: [{ type: 'text', text: `network-denied:${error instanceof Error ? error.message : String(error)}` }], isError: true },
      }));
    }
  }
}
