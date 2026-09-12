#!/usr/bin/env node
// Restricted host for Graph extension capabilities.
//
// The background process never imports third-party extension code. Instead the
// OS-restricted executor starts this small host with read access to the
// installed snapshot and write access to the work copy, and the extension only
// sees the minimal `register(api)` face below. Tools are served one process per
// exchange over the same JSON-RPC shape as MCP, so extension calls share the
// send gate, metering and pause rules.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const entry = process.argv[2];
if (!entry) {
  console.error('graph-extension-worker: missing extension entry');
  process.exit(2);
}

const tools = new Map();
const api = {
  tool(spec) {
    if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || typeof spec.execute !== 'function') {
      throw new Error('api.tool requires a nonempty name and an execute function');
    }
    if (tools.has(spec.name)) throw new Error(`Duplicate tool ${spec.name}`);
    tools.set(spec.name, spec);
  },
};

let loaded;
try {
  loaded = await import(pathToFileURL(entry).href);
} catch (error) {
  console.error(`graph-extension-worker: cannot load ${entry}: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}
const register = loaded.register ?? loaded.default?.register ?? loaded.default;
if (typeof register !== 'function') {
  console.error('graph-extension-worker: extension must export register(api)');
  process.exit(2);
}
try {
  await register(api);
} catch (error) {
  console.error(`graph-extension-worker: register failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(2);
}

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); }
  catch { continue; }
  if (request?.method === 'notifications/initialized') continue;
  let result;
  let error;
  if (request?.method === 'initialize') {
    result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'graph-extension', version: '1.0.0' } };
  } else if (request?.method === 'tools/list') {
    result = { tools: [...tools.values()].map(tool => ({
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters ? { inputSchema: tool.parameters } : {}),
    })) };
  } else if (request?.method === 'tools/call') {
    const tool = tools.get(request.params?.name);
    if (!tool) error = { code: -32601, message: `Unknown tool ${request.params?.name}` };
    else {
      try {
        const value = await tool.execute(request.params?.arguments ?? {});
        result = { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value ?? null) }], isError: false };
      } catch (callError) {
        result = { content: [{ type: 'text', text: callError instanceof Error ? callError.message : String(callError) }], isError: true };
      }
    }
  } else {
    continue;
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...(error ? { error } : { result }) }));
}
