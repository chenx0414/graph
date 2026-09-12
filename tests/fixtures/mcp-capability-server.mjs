import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

// A scripted MCP capability server. Real stdio; one process per exchange.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'capability-fixture', version: '1.0.0' } };
  } else if (request.method === 'tools/list') {
    result = { tools: [{ name: 'write_proof', description: 'Write an authorized proof file', inputSchema: { type: 'object', properties: { outside: { type: 'string' } }, required: ['outside'] } }] };
  } else if (request.method === 'tools/call') {
    writeFileSync('mcp-capability.txt', 'mcp capability write');
    let outsideDenied = false;
    try { writeFileSync(request.params.arguments.outside, 'bad'); } catch { outsideDenied = true; }
    result = { content: [{ type: 'text', text: JSON.stringify({ outsideDenied }) }], isError: false };
  } else { continue; }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
