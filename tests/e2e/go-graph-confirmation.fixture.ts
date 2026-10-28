import { createServer, type Server } from 'node:http';

import { execFile } from 'node:child_process';

import { promisify } from 'node:util';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
export const run = promisify(execFile);

export interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }

export interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }

export interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

export interface MasterCall {
  id: string;
  name: string;
  /** The arguments, resolved when the call goes out - not when the plan is read. */
  args: unknown | (() => unknown);
  /** The host-side work this call depends on, done before the call goes out. */
  before?: () => Promise<void>;
}

export async function masterProvider(plan: (body: ChatBody) => MasterCall[]) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  let turns = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    turns += 1;
    const next = plan(body).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The graph is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const args = typeof next.args === 'function' ? next.args() : next.args;
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    failures,
    turns: () => turns,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export async function nodeProvider() {
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const withTools = (body.tools ?? []).length > 0;
    const history = (body.messages ?? []).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).join('\n');
    const deliveries = [...history.matchAll(/NEW DELIVERY: (\{.*\})/g)].map(match => match[1]!);
    const submitted = (body.messages ?? []).filter(message => (message.tool_calls ?? []).some(call => call.function?.name === 'submit')).length;
    let value: { n?: number } = {};
    if (deliveries.length > submitted) {
      const payload = JSON.parse(deliveries[deliveries.length - 1]!) as { value?: { n?: number } };
      value = payload.value ?? {};
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (withTools && deliveries.length > submitted) {
      // The first node publishes forty two; the second, which was handed that
      // value, publishes forty three.
      const published = value.n === 0 ? { n: 42 } : { n: 43 };
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: published } } }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 40, completion_tokens: 10 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The answer.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 40, completion_tokens: 10 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    requests,
    turns: () => requests.filter(body => (body.tools ?? []).length > 0),
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export const DEFINITION = {
  schemaVersion: 2,
  name: 'chain',
  protocols: { ping: { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } },
  nodes: {
    a: {
      recipe: 'coder@1', model: 'sender', task: 'Publish the first number',
      inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
    },
    b: {
      recipe: 'coder@1', model: 'sender', task: 'Publish the second number',
      inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } }, submission: { required: ['out'] },
    },
  },
  modules: {
    gate: {
      type: 'router', trigger: 'each', inputs: { in: { protocol: 'ping' } }, outputs: { out: { protocol: 'ping' } },
      rules: [{ when: 'in.n > 0', emit: { out: '$in' } }],
    },
  },
  edges: { ab: { from: 'a.out', to: 'b.in', enabled: true } },
  acceptance: [{ id: 'works', description: 'The chain runs through', kind: 'human' }],
};

export const PROPOSAL = {
  requirementVersion: 1,
  summary: 'A two node chain',
  acceptance: [{ id: 'works', description: 'The chain runs through', checkNode: 'b' }],
  definition: DEFINITION,
};
