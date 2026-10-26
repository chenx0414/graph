import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { anthropicMessagesServer } from '../fixtures/anthropic-messages-server.ts';

/**
 * The tool flow the provider sees.
 *
 * Two facts decide it, and both were broken:
 *
 *   - A stream that ends before the answer is complete is a failed send. The
 *     daemon used to finish such a stream as a normal turn, so the tool call it
 *     carried ran - with whatever the half-written arguments happened to parse
 *     to - and the turn was reported as a success.
 *   - Every tool call a request carries needs its result. The daemon renders the
 *     transcript itself, so it has to close a call whose result never arrived,
 *     the way Pi does before it sends a request. On the Anthropic path the
 *     daemon dropped the tool call itself, so the provider saw a result that
 *     answered a call it had never been told about.
 *
 * Both are proved here against the real daemon and a real provider: only the
 * external vendor is replaced.
 */

interface ProviderMessage {
  role?: string;
  content?: unknown;
  tool_calls?: { id?: string; function?: { name?: string } }[];
}

/** The tool messages one provider request carries, keyed by the call they answer. */
function answeredCalls(messages: ProviderMessage[]): Map<string, string> {
  const answered = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const id = (message as { tool_call_id?: string }).tool_call_id ?? '';
    answered.set(id, String(message.content ?? ''));
  }
  return answered;
}

/** Every tool call one provider request carries. */
function requestedCalls(messages: ProviderMessage[]): { id: string; name: string }[] {
  const calls: { id: string; name: string }[] = [];
  for (const message of messages) {
    for (const call of message.tool_calls ?? []) {
      calls.push({ id: call.id ?? '', name: call.function?.name ?? '' });
    }
  }
  return calls;
}

async function projectFixture(root: string): Promise<string> {
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Tool flow project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  return project;
}

test('a provider that closes the stream before the answer is complete fails the turn instead of running the tool', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-flow-cut-'));
  const project = await projectFixture(root);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const marker = join(project, 'cut-marker.txt');
  // The provider writes the tool call and then closes the connection: the answer
  // never arrived, so the turn never happened.
  const provider = await openaiServer([
    { tools: [{ id: 'cut-call', name: 'bash', arguments: JSON.stringify({ command: `printf cut > ${marker}` }) }], cut: true },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_TOOL_FLOW_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_TOOL_FLOW_KEY: 'synthetic-tool-flow-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Run the command for me.', requestId: 'cut-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The turn ends with the failure the cut stream was. It must not end as a
    // successful turn with nothing in it.
    let status = '';
    let view: unknown = {};
    await expect.poll(async () => {
      const reply = await request(`/api/conversations/${conversationId}`);
      view = reply.body;
      status = (reply.body as { master?: { status?: string } }).master?.status ?? '';
      const messages = (reply.body as { messages?: { role?: string; kind?: string }[] }).messages ?? [];
      return messages.some(message => message.role === 'system' && message.kind === 'error');
    }, { timeout: 60000, interval: 250 }).toBe(true);
    const messages = (view as { messages?: { role?: string; kind?: string; text?: string }[] }).messages ?? [];
    const failure = messages.find(message => message.role === 'system' && message.kind === 'error');
    expect(failure?.text ?? '', 'the failure does not name the reason').toContain('not answered');
    expect(status, `the cut stream was reported as ${status}\nview: ${JSON.stringify(view).slice(0, 3000)}\nrequests: ${JSON.stringify(provider.requests.map(entry => (entry as { messages?: { role?: string }[] }).messages?.map(message => message.role)))}\nstderr: ${daemon?.stderr ?? ''}`).not.toBe('succeeded');
    // The tool never ran: a half-written answer is not an answer, and the
    // side effect of a turn that never happened must not happen.
    const database = join(root, 'state/tasks.sqlite');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      const calls = db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE tool='bash'").get() as { n: number };
      expect(calls.n, 'the tool of the cut turn ran').toBe(0);
    } finally { db.close(); }
    await expect(readFile(marker, 'utf8').catch(() => '')).resolves.toBe('');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);

test('the Anthropic request carries the tool call and the result that answers it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-flow-anthropic-'));
  const project = await projectFixture(root);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const marker = join(project, 'anthropic-marker.txt');
  const provider = await anthropicMessagesServer([
    { tool: { id: 'anthropic-call', name: 'bash', input: { command: `printf anthropic > ${marker}` } } },
    { text: 'The command ran.' },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_TOOL_FLOW_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-anthropic', grade: 'high',
        api: 'anthropic-messages', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_TOOL_FLOW_KEY: 'synthetic-tool-flow-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Run the command for me.', requestId: 'anthropic-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // The second request is the one that carries the tool flow: the call the
    // model made and the result that answered it.
    await expect.poll(() => provider.requests.length, { timeout: 60000, interval: 250 }).toBeGreaterThan(1);
    const messages = (provider.requests[1]?.body.messages ?? []) as ProviderMessage[];
    const blocks = messages.flatMap(message => Array.isArray(message.content) ? message.content as { type?: string; id?: string; tool_use_id?: string }[] : []);
    const toolUse = blocks.find(block => block.type === 'tool_use' && block.id === 'anthropic-call');
    expect(toolUse, `the request carries no tool_use block:\n${JSON.stringify(messages)}`).toBeTruthy();
    const toolResult = blocks.find(block => block.type === 'tool_result' && block.tool_use_id === 'anthropic-call');
    expect(toolResult, `the request carries no tool_result block:\n${JSON.stringify(messages)}`).toBeTruthy();
    // Every tool call of the request has a result: a provider rejects a flow
    // that leaves a call open.
    for (const call of requestedCalls(messages)) {
      expect(answeredCalls(messages).has(call.id), `the call ${call.id} has no result`).toBe(true);
    }

    // The request tells the provider what to keep. The daemon builds the
    // request itself, so without the breakpoints the provider's prompt cache
    // is never written and every session pays for its prefix again.
    const body = provider.requests[0]!.body;
    const system = Array.isArray(body.system) ? body.system as { type?: string; cache_control?: unknown }[] : [];
    expect(system.length, 'the system prompt is not a block list').toBeGreaterThan(0);
    expect(system[0]!.cache_control, 'the system prompt has no cache breakpoint').toEqual({ type: 'ephemeral' });
    const tools = (body.tools ?? []) as { cache_control?: unknown }[];
    expect(tools.length, 'the request declares no tools').toBeGreaterThan(0);
    expect(tools[tools.length - 1]!.cache_control, 'the last tool has no cache breakpoint').toEqual({ type: 'ephemeral' });
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
