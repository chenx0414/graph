import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The host inventory the main Agent may read.
 *
 * The main Agent is the only Agent that is told what the host looks like:
 * which models are configured, which recipes and definitions exist, which
 * capabilities are installed, what the subscription plans report. Without that
 * inventory the main Agent has to guess - and a guess about "which model can I
 * use" is a guess about the user's money.
 *
 * The inventory never carries a secret value: a credential is reported as
 * configured or not, never as its value. A host that has many sections may
 * also hand them out one at a time, so a model that only needs one fact does
 * not have to read the whole table.
 *
 * The proof is the real daemon and a real model turn: the model asks for the
 * inventory, gets it, and acts on it - it writes the model it found into the
 * workspace.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody {
  tools?: { function?: { name?: string; parameters?: { properties?: Record<string, unknown> } } }[];
  messages?: ChatMessage[];
}

/** The inventory sections the host reports. */
const SECTIONS = [
  'configuredModels', 'agentCombinations', 'agentDefinitions', 'architectures',
  'subscriptionPlans', 'summary', 'capabilities', 'agentContext', 'application',
];

/** The model id the inventory reports, read out of whatever the tool answered. */
function configuredModelId(messages: ChatMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    let parsed: any;
    try { parsed = JSON.parse(String(message.content ?? '{}')); }
    catch { continue; }
    const models = parsed?.configuredModels ?? parsed?.configuredModels?.configuredModels;
    if (Array.isArray(models) && models.length) return String(models[0].id ?? '');
  }
  return '';
}

/**
 * A provider that answers the main Agent's inventory calls in order.
 *
 * Each entry of `sections` is one `read_system_capabilities` call: an empty
 * string asks for the whole inventory, a name asks for that one section.
 * After the last call the model writes the model it found into the workspace,
 * which is what proves the inventory reached the model in a usable form.
 */
async function inventoryProvider(sections: string[]) {
  const requests: ChatBody[] = [];
  const pending = sections.map(section => (section ? { section } : {}));
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
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
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const call = (id: string, name: string, args: unknown) => {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    if (pending.length) {
      call(`inventory-${pending.length}`, 'read_system_capabilities', pending.shift());
      return;
    }
    if (!spoken.has('pick')) {
      const id = configuredModelId(body.messages ?? []);
      call('pick', 'bash', { command: `printf '%s' '${id}' > selected-model.txt` });
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Discovery completed.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function fixture(prefix: string, scoped: boolean, sections: string[]) {
  const provider = await inventoryProvider(sections);
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), `graph-e2e-go-system-capabilities-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, {
    configPath,
    env: { GRAPH_LOCAL_KEY: 'key-local', GRAPH_SCOPED_SYSTEM_CAPABILITIES: scoped ? '1' : '0' },
    extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const response = await daemon.request(path, init);
    const body = await response.json().catch(() => ({})) as T;
    return { status: response.status, body };
  };
  return { root, project, provider, daemon, request };
}

/** The tool table of the first request the provider received. */
function toolTable(body: ChatBody | undefined): { name?: string; parameters?: { properties?: Record<string, unknown> } } {
  return (body?.tools ?? []).map(tool => tool.function ?? {}).find(tool => tool.name === 'read_system_capabilities') ?? {};
}

/** The tool answers of one request, in the order the model asked for them. */
function toolAnswers(body: ChatBody | undefined): any[] {
  const answers: any[] = [];
  for (const message of body?.messages ?? []) {
    if (message.role !== 'tool') continue;
    try { answers.push(JSON.parse(String(message.content ?? '{}')) as any); }
    catch { /* a tool that answered with text, not with a document */ }
  }
  return answers;
}

test('the main Agent reads the whole host inventory and acts on it', async () => {
  const f = await fixture('full', false, ['']);

  const created = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Discover the configured model.', requestId: 'inventory' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);

  // The model really used what it was told: the id it found is in the workspace.
  await expect.poll(async () => readFile(join(f.project, 'selected-model.txt'), 'utf8').catch(() => ''), { timeout: 60_000, interval: 250 })
    .toBe('local');

  // The tool is offered to the main Agent, and the answer is the whole inventory.
  const first = f.provider.requests.find(body => (body.tools ?? []).length);
  expect(toolTable(first).name).toBe('read_system_capabilities');
  // The transcript of the last request carries every tool answer.
  const last = f.provider.requests.filter(body => (body.tools ?? []).length).at(-1);
  const answers = toolAnswers(last);
  const inventory = answers[0] as Record<string, any>;
  expect(Object.keys(inventory)).toEqual(expect.arrayContaining(SECTIONS));
  expect(inventory.configuredModels).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'local' })]));
  expect(inventory.application).toBeTruthy();
  // The sections are not empty shells: the host really has recipes and
  // architectures to report.
  expect((inventory.agentCombinations as unknown[]).length).toBeGreaterThan(0);
  expect((inventory.architectures as unknown[]).length).toBeGreaterThan(0);
  expect((inventory.agentDefinitions as unknown[]).length).toBeGreaterThan(0);
  // A secret is never part of the inventory.
  expect(JSON.stringify(inventory)).not.toContain('key-local');
}, 180_000);

test('a scoped host hands out one inventory section at a time', async () => {
  const f = await fixture('scoped', true, ['', ...SECTIONS]);

  const created = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: 'Discover the configured model.', requestId: 'scoped' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  await expect.poll(async () => readFile(join(f.project, 'selected-model.txt'), 'utf8').catch(() => ''), { timeout: 60_000, interval: 250 })
    .toBe('local');

  // The scoped tool takes a section, and only the sections it knows.
  const first = f.provider.requests.find(body => (body.tools ?? []).length);
  expect(Object.hasOwn(toolTable(first).parameters?.properties ?? {}, 'section')).toBe(true);

  // Every section the model asked for came back as exactly that section.
  const last = f.provider.requests.filter(body => (body.tools ?? []).length).at(-1);
  const answers = toolAnswers(last);
  const full = answers[0] as Record<string, any>;
  expect(Object.keys(full)).toEqual(expect.arrayContaining(SECTIONS));
  const sections = answers.slice(1);
  expect(sections).toHaveLength(SECTIONS.length);
  SECTIONS.forEach((section, index) => {
    expect(Object.keys(sections[index] ?? {})).toEqual([section]);
    expect(sections[index]?.[section]).toEqual(full[section]);
  });
}, 180_000);
