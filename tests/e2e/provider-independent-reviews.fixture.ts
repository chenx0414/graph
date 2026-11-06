import { readFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

/**
 * The fixtures of the independent-provider test.
 *
 * The subscription credentials are the host's own: the tokens live in the CLI
 * auth files the product itself reads for subscription usage
 * (`~/.grok/auth.json`, `~/.codex/auth.json`). Nothing here prints them, and a
 * host without them fails the test instead of faking a completion.
 */

export const DATA = { protocol: 'data' };

export interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
export interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
export interface Step { id: string; name: string; args: unknown; before?: () => Promise<void> }

/**
 * The two entries as they are delivered for graph.config.json. The test loads
 * the delivered file so the artifact and the proof cannot drift apart.
 */
export async function independentEntries(): Promise<{ grok: Record<string, unknown>; chatgpt: Record<string, unknown> }> {
  const raw = await readFile(join(process.cwd(), 'docs', 'evidence', 'independent-model-entries.json'), 'utf8');
  const parsed = JSON.parse(raw) as { models: { entries: { id: string }[] } };
  const grok = parsed.models.entries.find(entry => entry.id.startsWith('grok:'));
  const chatgpt = parsed.models.entries.find(entry => entry.id.startsWith('chatgpt:'));
  if (grok === undefined || chatgpt === undefined) {
    throw new Error('docs/evidence/independent-model-entries.json must carry one grok: entry and one chatgpt: entry');
  }
  return { grok: grok as Record<string, unknown>, chatgpt: chatgpt as Record<string, unknown> };
}

/** The Grok access token the host's Grok CLI is signed in with.
 *
 * The access token in that file lives about an hour, so a login made earlier in
 * the day is already dead when the gate runs: measured 2026-11-05, the same file
 * answered `Provider answered HTTP 403` and blocked every commit for hours after
 * a successful login. The refresh token the CLI already stored is exchanged
 * here, in memory - the host's file is never rewritten, and a host that is not
 * signed in at all still fails instead of faking a completion.
 */
export async function grokAccessToken(): Promise<string> {
  const path = join(homedir(), '.grok', 'auth.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`no connected Grok subscription: ${path} is unreadable (${String(error)}). This test proves a real completion and cannot fake one`);
  }
  const scopes = JSON.parse(raw) as Record<string, { key?: unknown; refresh_token?: unknown; expires_at?: unknown; oidc_issuer?: unknown; oidc_client_id?: unknown }>;
  for (const scope of Object.keys(scopes)) {
    if (!scope.startsWith('https://auth.x.ai::')) continue;
    const entry = scopes[scope]!;
    const key = entry.key;
    if (typeof key !== 'string' || key.trim() === '') continue;
    const expiresAt = typeof entry.expires_at === 'string' ? Date.parse(entry.expires_at) : Number.NaN;
    const stale = Number.isFinite(expiresAt) ? expiresAt - Date.now() < 120_000 : false;
    if (!stale) return key.trim();
    const refreshToken = typeof entry.refresh_token === 'string' ? entry.refresh_token : '';
    const issuer = typeof entry.oidc_issuer === 'string' ? entry.oidc_issuer : 'https://auth.x.ai';
    const clientId = typeof entry.oidc_client_id === 'string' ? entry.oidc_client_id : '';
    if (!refreshToken || !clientId) return key.trim();
    const response = await fetch(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    const body = await response.json().catch(() => ({})) as { access_token?: unknown };
    if (!response.ok || typeof body.access_token !== 'string' || body.access_token.trim() === '') {
      throw new Error(`the Grok CLI login expired at ${String(entry.expires_at)} and its refresh answered ${response.status}: sign in with the Grok CLI again`);
    }
    return body.access_token.trim();
  }
  throw new Error(`the Grok auth file ${path} holds no https://auth.x.ai scope with a key`);
}

/** The ChatGPT/Codex subscription token and the account it belongs to. */
export async function chatgptCredential(): Promise<{ token: string; accountId: string }> {
  const path = join(homedir(), '.codex', 'auth.json');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`no connected ChatGPT subscription: ${path} is unreadable (${String(error)}). This test proves a real completion and cannot fake one`);
  }
  const parsed = JSON.parse(raw) as { tokens?: { access_token?: unknown; account_id?: unknown } };
  const token = parsed.tokens?.access_token;
  const accountId = parsed.tokens?.account_id;
  if (typeof token !== 'string' || token.trim() === '' || typeof accountId !== 'string' || accountId.trim() === '') {
    throw new Error(`the ChatGPT auth file ${path} holds no tokens.access_token / tokens.account_id`);
  }
  return { token: token.trim(), accountId: accountId.trim() };
}

/** One scripted model: it plays the plan in order and records what every call answered. */
export async function scriptedProvider(plan: () => Step[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
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
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Nothing left to say.' }, finish_reason: 'stop' }],
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
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results, failures, requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The node model that does the work this graph reviews: it writes and submits. */
export async function implementerProvider() {
  const turns: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    turns.push(body);
    if (turns.length === 1) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'write', type: 'function',
        function: { name: 'write_file', arguments: JSON.stringify({ path: 'delivered.txt', content: 'the delivered work\n' }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    if (turns.length === 2) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit', type: 'function',
        function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { delivered: 'delivered.txt', summary: 'wrote the delivered work' } } } }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Submitted.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    turns,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** Rows one graph really has in its own state database. */
export function rows<T>(root: string, query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
  try {
    return db.prepare(query).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

export interface ProviderCall {
  id: string; nodeId: string; state: string;
  usage?: { input?: number; output?: number } | null;
  model: { id: string; provider: string; api: string; recipe?: { definition: string; review: boolean } };
}

/**
 * An endpoint that accepts the request and closes the connection without an
 * answer, at the path a Responses send uses: the client sees the provider break
 * the connection (EOF). It lets a test make that failure happen every run
 * instead of only when a real backend happens to break.
 */
export async function closingEndpoint() {
  const hits: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    hits.push(`${request.method ?? 'POST'} ${request.url ?? '/'}`);
    // No status line, no headers: the connection dies the way a broken endpoint
    // does, and the client reports EOF.
    response.destroy();
    request.socket.destroy();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    hits,
    baseUrl: `http://127.0.0.1:${port}/backend-api/codex`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
