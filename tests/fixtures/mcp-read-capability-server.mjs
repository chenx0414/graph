import { createInterface } from 'node:readline';

// A read-only MCP capability server for conversation-path tests.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'read-fixture', version: '1.0.0' } };
  } else if (request.method === 'tools/list') {
    result = {
      tools: [{
        name: 'search_repositories',
        description: 'Search repositories by query.',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      }],
    };
  } else if (request.method === 'tools/call') {
    result = { content: [{ type: 'text', text: `repositories:${request.params.arguments.query}` }], isError: false };
  } else {
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
