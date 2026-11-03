import { DatabaseSync } from 'node:sqlite';

import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
export const FIXTURES = fileURLToPath(new URL('../fixtures/legacy', import.meta.url));

export const SCHEMA_VERSION = 53;

export interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }

export interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }

export interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

export function readDb<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path, { readOnly: true });
  try { return read(db); }
  finally { db.close(); }
}

export function columnsOf(db: DatabaseSync, table: string): string[] {
  return db.prepare(`PRAGMA table_info(${table})`).all().map(column => String(column.name));
}

export const UPGRADE_DEFINITION = {
  schemaVersion: 2,
  name: 'Native upgrade',
  protocols: { data: { type: 'object', required: ['upgraded'], properties: { upgraded: { type: 'boolean' } } } },
  nodes: {
    work: {
      recipe: 'coder@1', model: 'local', task: 'Submit the upgrade result',
      inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
      submission: { required: ['result'] },
    },
  },
  modules: {}, edges: {}, inputs: {},
  outputs: { result: { from: 'work.result', protocol: 'data' } },
};

export interface MasterCall {
  id: string; name: string; args: unknown;
  /** Ask again until the answer says what the call was waiting for. */
  until?: (results: Map<string, string>) => boolean;
}

export async function masterProvider(plan: (graphId: string) => MasterCall[]) {
  const results = new Map<string, string>();
  const repeats = new Map<string, number>();
  const served = new Map<string, string>();
  let graphId = '';
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    try { for await (const chunk of request) chunks.push(chunk); }
    catch (error) { if (request.aborted) return; throw error; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id ?? '';
      if (base) results.set(base, content);
      const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
      if (found) graphId = found[1]!;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking: it is the master
    // asking for a next-message suggestion.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan(graphId).find(call => !spoken.has(call.id) || (call.until && !call.until(results)));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The upgrade is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const repeat = repeats.get(next.id) ?? 0;
    const id = repeat === 0 ? next.id : `${next.id}-${repeat}`;
    if (next.until && !next.until(results)) repeats.set(next.id, repeat + 1);
    served.set(id, next.id);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export async function nodeProvider() {
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    try { for await (const chunk of request) chunks.push(chunk); }
    catch (error) { if (request.aborted) return; throw error; }
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ready.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } })}\n\n`);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
      function: { name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { upgraded: true } } } }) } }] }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
