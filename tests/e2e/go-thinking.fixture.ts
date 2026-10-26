import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { afterEach, expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
export const cleanup: (() => Promise<void> | void)[] = [];


afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

export interface Endpoint {
  baseUrl: string;
  bodies: Record<string, unknown>[];
  close: () => Promise<void>;
}

export async function anthropicEndpoint(text = 'Answered.'): Promise<Endpoint & { headers: Record<string, string>[] }> {
  const bodies: Record<string, unknown>[] = [];
  const headers: Record<string, string>[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); }
    catch { bodies.push({}); }
    headers.push(Object.fromEntries(Object.entries(request.headers)
      .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value ?? ''])));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant',
      content: [], model: 'claude', usage: { input_tokens: 10, output_tokens: 1 } } }));
    response.write(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }));
    response.write(frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }));
    response.write(frame({ type: 'content_block_stop', index: 0 }));
    response.write(frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }));
    response.write(frame({ type: 'message_stop' }));
    response.end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    headers,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export async function endpoint(text = 'Answered.'): Promise<Endpoint> {
  const bodies: Record<string, unknown>[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    try { bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>); }
    catch { bodies.push({}); }
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    bodies,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export interface Case {
  id: string;
  provider: string;
  modelId: string;
  levels: string[];
  requested?: string;
  defaultThinkingLevel?: string;
  selected: string;
  /** 'none' marks a provider that is not asked for a strength in the plain way. */
  wire?: 'none';
}

export const cases: Case[] = [
  // 'max' is stronger than grok offers: the nearest strength it does offer wins.
  { id: 'grok', provider: 'grok', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], requested: 'max', selected: 'xhigh' },
  // 'medium' sits between deepseek's levels: the next stronger one wins.
  { id: 'deepseek', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], requested: 'medium', selected: 'high' },
  // A saved default the model does not accept is clamped the same way.
  { id: 'account', provider: 'opencode-go-3', modelId: 'deepseek-v4.1-flash', levels: ['low', 'high', 'max'], defaultThinkingLevel: 'xhigh', selected: 'max' },
  // Without a request the model runs at its second strongest strength.
  { id: 'toggle', provider: 'opencode-go', modelId: 'mimo-v2.6-pro', levels: ['minimal', 'low', 'medium', 'high'], selected: 'medium' },
  // A model the catalog does not know still runs: its own default levels apply.
  { id: 'unknown', provider: 'no-such-provider', modelId: 'no-such-model', levels: ['minimal', 'low', 'medium', 'high'], defaultThinkingLevel: 'xhigh', selected: 'high' },
  // 'off' is not a strength: the nearest one the model takes wins.
  { id: 'deepseek-off', provider: 'deepseek', modelId: 'deepseek-flash', levels: ['low', 'high', 'max'], requested: 'off', selected: 'low' },
  // A model with one strength runs at that one.
  { id: 'single', provider: 'nano-gpt', modelId: 'openai/gpt-5-pro', levels: ['high'], selected: 'high' },
  // A provider that does not understand the plain effort field is not asked in
  // that way at all: a request it cannot read is a request it refuses.
  { id: 'xai', provider: 'xai', modelId: 'grok-4.6', levels: ['low', 'medium', 'high', 'xhigh'], selected: 'high', wire: 'none' },
  // A model with no discrete strengths runs without one at all.
  { id: 'empty', provider: 'llmgateway-providers', modelId: 'novita/ling-3.0-flash', levels: [], selected: 'off' },
];

export interface ModelRow { id: string; thinkingOptions?: { level: string; label: string }[] }

export interface ConversationView { master?: { status?: string }; telemetry?: { model?: string; thinkingLevel?: string } }
