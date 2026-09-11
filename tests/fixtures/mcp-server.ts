import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';

// A scripted MCP peer. Real stdio and filesystem; no external SDK or service.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  let result: unknown;
  if (request.method === 'initialize') {
    result = { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'graph-fixture', version: '1.0.0' } };
  } else if (request.method === 'tools/call') {
    writeFileSync('mcp-result.txt', 'authorized MCP write');
    let outsideDenied = false;
    try { writeFileSync(request.params.arguments.outside, 'bad'); } catch { outsideDenied = true; }
    result = { content: [{ type: 'text', text: JSON.stringify({ outsideDenied }) }], isError: false };
  } else { continue; }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
