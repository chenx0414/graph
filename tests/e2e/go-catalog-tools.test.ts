import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The catalog the master may read.
 *
 * The master can look at the recipes the daemon ships and pick a subagent
 * from them. The catalog surface is bound on demand - the master is offered
 * a loader, and the recipes themselves arrive in the tool surface only after
 * the loader has run. That capability has to be real: the loader really
 * binds the tools, the bound tools really answer with the recipes the daemon
 * published, and they answer the same way after the daemon has been
 * restarted - a tool that only exists in one process is a tool that breaks on
 * every upgrade.
 *
 * A tool that takes no parameters is the sharpest case: its call carries an
 * empty argument object, and a runtime that drops the empty object hands the
 * worker a call with no arguments at all - which the tool schema refuses.
 *
 * The proof is the real daemon and a real model turn.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

interface MasterCall { id: string; name: string; args: unknown }

interface Provider {
  /** Where the master may send its requests. */
  baseUrl: string;
  /** What every request asked for, in order. */
  requests: ChatBody[];
  /** The answer each tool call received. */
  results: Map<string, string>;
  /** The tool names each request was offered. */
  toolsOf: (index: number) => string[];
  close: () => Promise<void>;
}

/**
 * The master Agent. It plays the plan in order and records what every tool
 * call received, so the test reads the catalog the way the model read it.
 */
async function masterProvider(plan: () => MasterCall[]): Promise<Provider> {
  const requests: ChatBody[] = [];
  const results = new Map<string, string>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
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
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The catalog is as expected.' }, finish_reason: 'stop' }],
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
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    results,
    toolsOf: (index: number) => (requests[index]?.tools ?? []).map(tool => tool.function?.name ?? ''),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The tool result the model read, as plain text. */
function resultOf(master: Provider, id: string): string {
  return master.results.get(id) ?? '';
}

test('the catalog surface is bound on demand, answers with real recipes, and survives a restart', async () => {
  const master = await masterProvider(() => [
    { id: 'load-1', name: 'load_catalog_tools', args: {} },
    { id: 'list-1', name: 'list_agent_combinations', args: {} },
    { id: 'get-1', name: 'get_agent_combination', args: { id: 'main' } },
    { id: 'list-2', name: 'list_agent_combinations', args: {} },
  ]);
  cleanup.push(() => master.close());

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-catalog-tools-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{
      id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
  }));

  const env = { GRAPH_LOCAL_KEY: 'catalog-synthetic', GRAPH_DEFER_CATALOG_TOOLS: '1' };
  let daemon = await launchCli(root, { configPath, env, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };

  const started = await request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Which subagents can I use?', requestId: 'catalog' }),
  });
  expect(started.status, JSON.stringify(started.body)).toBe(200);
  const conversationId = (started.body as { conversationId: string }).conversationId;

  // The very first request offers the loader, not the catalog itself: the
  // recipes are bound on demand.
  await expect.poll(() => master.results.has('load-1'), { timeout: 60_000, interval: 250 }).toBeTruthy();
  expect(master.toolsOf(0)).toContain('load_catalog_tools');
  expect(master.toolsOf(0)).not.toContain('list_agent_combinations');

  // The loader really ran, and the catalog really arrived with the next
  // request.
  expect(resultOf(master, 'load-1')).toContain('list_agent_combinations');
  await expect.poll(() => master.results.has('list-1'), { timeout: 60_000, interval: 250 }).toBeTruthy();
  const bound = master.requests.findIndex(request => (request.tools ?? []).some(tool => tool.function?.name === 'list_agent_combinations'));
  expect(bound).toBeGreaterThan(0);
  expect(master.toolsOf(bound)).toContain('get_agent_combination');

  // The catalog tools really ran: they answered with what the daemon really
  // holds, not with a refusal and not with a schema complaint about the
  // arguments.
  const listed = JSON.parse(resultOf(master, 'list-1')) as { total: number; items: { id: string }[] };
  expect(listed.total).toBeGreaterThanOrEqual(1);
  expect(listed.items.map(item => item.id)).toContain('main');
  expect(resultOf(master, 'list-1')).not.toMatch(/unknown tool|not found|not available|Validation failed/i);

  await expect.poll(() => master.results.has('get-1'), { timeout: 60_000, interval: 250 }).toBeTruthy();
  const detail = JSON.parse(resultOf(master, 'get-1')) as { id: string; name: string; mode: string; recommendedGrade: string };
  expect(detail).toMatchObject({ id: 'main', mode: 'main', recommendedGrade: 'high' });
  expect(detail.name).not.toBe('');
  expect(resultOf(master, 'get-1')).not.toMatch(/unknown tool|not found|not available|Validation failed/i);

  // The daemon restarts. The conversation and the bound catalog are still
  // there, and the tool still answers.
  await daemon.close();
  daemon = await launchCli(root, { configPath, env, extraArgs: ['--execute'] });
  const asked = await request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'And after a restart?', requestId: 'catalog-again' }),
  });
  expect(asked.status, JSON.stringify(asked.body)).toBe(200);

  await expect.poll(() => master.results.has('list-2'), { timeout: 60_000, interval: 250 }).toBeTruthy();
  const again = JSON.parse(resultOf(master, 'list-2')) as { total: number; items: { id: string }[] };
  expect(again.total).toBeGreaterThanOrEqual(1);
  expect(again.items.map(item => item.id)).toContain('main');
  expect(resultOf(master, 'list-2')).not.toMatch(/unknown tool|not found| not available|Validation failed/i);
}, 240_000);

test('a catalog tool that takes no parameters still runs', async () => {
  const master = await masterProvider(() => [
    { id: 'projects-1', name: 'list_projects', args: {} },
  ]);
  cleanup.push(() => master.close());

  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-catalog-empty-args-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{
      id: 'local', modelId: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
    }] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_LOCAL_KEY: 'catalog-synthetic' }, extraArgs: ['--execute'] });
  cleanup.push(() => daemon.close());
  const response = await daemon.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Which projects do I have?', requestId: 'projects' }),
  });
  expect(response.status).toBe(200);

  // The call carries an empty argument object. A runtime that drops the empty
  // object hands the worker a call with no arguments at all, and the tool
  // schema refuses it.
  await expect.poll(() => master.results.has('projects-1'), { timeout: 60_000, interval: 250 }).toBeTruthy();
  const projects = JSON.parse(resultOf(master, 'projects-1')) as { id: string; root: string }[];
  expect(Array.isArray(projects)).toBe(true);
  expect(projects.map(entry => entry.id)).toContain('p');
  expect(projects.find(entry => entry.id === 'p')?.root).toContain('project');
  expect(resultOf(master, 'projects-1')).not.toMatch(/unknown tool|not found|not available|Validation failed/i);
}, 240_000);
