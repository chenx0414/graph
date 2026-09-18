import { createInterface } from 'node:readline';

const key = process.env.MCP_CONFIG_TEST_TOKEN;
if (!key) {
  process.stderr.write('MCP_CONFIG_TEST_TOKEN is required\n');
  process.exit(2);
}

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'notifications/initialized') continue;
  let result;
  if (request.method === 'initialize') {
    result = {
      protocolVersion: request.params?.protocolVersion ?? '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'configured-capability-fixture', version: '1.0.0' },
    };
  } else if (request.method === 'tools/list') {
    result = {
      tools: [{
        name: 'configured_search',
        description: `Configured search (${key.length} credential bytes)`,
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
    };
  } else if (request.method === 'tools/call') {
    result = {
      content: [{ type: 'text', text: `configured:${request.params?.arguments?.query ?? ''}:${key.length}` }],
      isError: false,
    };
  } else {
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
