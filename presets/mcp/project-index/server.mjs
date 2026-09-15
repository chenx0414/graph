import { createInterface } from 'node:readline';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';

// Read-only project index MCP server. The host runs this process with the
// business workspace as cwd and (in discussion) write access limited to
// scratch, so every tool reads the project without modifying it.
const root = resolve(process.cwd());
const SKIP = new Set(['.git', 'node_modules', 'state', 'dist', 'coverage', '.stage', 'build']);
const MAX_FILE = 256 * 1024;
const MAX_RESULTS = 100;

function insideRoot(candidate) {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function safePath(input) {
  const target = resolve(root, input);
  if (!insideRoot(target)) throw new Error('Path escapes the project root');
  return target;
}

function walk(dir, files) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, files);
    else if (entry.isFile()) files.push(path);
  }
}

function search(query, maxResults) {
  if (typeof query !== 'string' || !query.trim()) throw new Error('query is required');
  const limit = Number.isSafeInteger(maxResults) ? Math.min(Math.max(maxResults, 1), MAX_RESULTS) : 20;
  const files = [];
  walk(root, files);
  const matches = [];
  for (const file of files.sort()) {
    if ((statSync(file).size) > MAX_FILE) continue;
    let text;
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    if (text.includes('\u0000')) continue;
    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      if (!lines[index].includes(query)) continue;
      matches.push({ path: relative(root, file), line: index + 1, text: lines[index].trim().slice(0, 200) });
      if (matches.length >= limit) return matches;
    }
  }
  return matches;
}

function read(path, maxBytes) {
  const target = safePath(path);
  const limit = Number.isSafeInteger(maxBytes) ? Math.min(Math.max(maxBytes, 1), 64 * 1024) : 32 * 1024;
  if (statSync(target).size > MAX_FILE) throw new Error('File is too large to read');
  return readFileSync(target, 'utf8').slice(0, limit);
}

const tools = [
  { name: 'project_search', description: 'Search the workspace text files for a literal string (read-only)', inputSchema: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] } },
  { name: 'project_read', description: 'Read one workspace text file (read-only, path confined to the workspace)', inputSchema: { type: 'object', properties: { path: { type: 'string' }, maxBytes: { type: 'number' } }, required: ['path'] } },
];

for await (const line of createInterface({ input: process.stdin })) {
  let request;
  try { request = JSON.parse(line); } catch { continue; }
  let result;
  try {
    if (request.method === 'initialize') {
      result = { protocolVersion: request.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'project-index', version: '1.0.0' } };
    } else if (request.method === 'tools/list') {
      result = { tools };
    } else if (request.method === 'tools/call') {
      const args = request.params?.arguments ?? {};
      if (request.params?.name === 'project_search') result = { content: [{ type: 'text', text: JSON.stringify(search(args.query, args.maxResults)) }] };
      else if (request.params?.name === 'project_read') result = { content: [{ type: 'text', text: read(args.path, args.maxBytes) }] };
      else result = { content: [{ type: 'text', text: `Unknown tool ${request.params?.name}` }], isError: true };
    } else { continue; }
  } catch (error) {
    result = { content: [{ type: 'text', text: String(error?.message ?? error) }], isError: true };
  }
  console.log(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
}
