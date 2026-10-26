import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * Sedimentation is a switch the user turns on, and a review that really runs.
 *
 * The configuration has to survive real saves: the defaults are what the
 * console shows, an invalid value is refused without touching the file on
 * disk, and the switch only means something when a real tool turn makes a
 * real review request - on the model the user chose, with that model's own
 * credential.
 *
 * The proof is the real daemon, the real model services and the real
 * configuration file.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface SedimentSettings {
  enabled: boolean;
  afterToolCalls: number;
  model: string | null;
  budgetTokens: number;
}

async function mainProvider() {
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[]; messages: { role: string; content: unknown }[] };
    const last = body.messages.at(-1);
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const read = Boolean(body.tools?.length) && last?.role === 'user'
      && JSON.stringify(user?.content).includes('Read the project lesson');
    const delta = read
      ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-lesson', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'lesson.txt' }) } }] }
      : { role: 'assistant', content: body.tools?.length && last?.role === 'tool' ? 'Read the concrete project lesson' : 'No tools yet' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: read ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-sediment-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'lesson.txt'), 'A concrete lesson from the user project.');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const main = await mainProvider();
  const reader = await openaiServer([{ text: '{"action":"nothing","id":"lesson","reason":"Nothing reusable"}' }]);
  cleanup.push(() => main.close(), () => reader.close());
  const configPath = join(root, 'graph.config.json');
  const entry = { id: 'main', provider: 'graph-main', modelId: 'main-model', grade: 'high', api: 'openai-completions',
    baseUrl: main.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'main' };
  const document = {
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { main: { secretRef: 'GRAPH_MAIN_KEY' }, reader: { secretRef: 'GRAPH_READER_KEY' } },
    models: { entries: [entry, { ...entry, id: 'reader', provider: 'graph-reader', modelId: 'reader-model', grade: 'low', credentialId: 'reader', baseUrl: reader.model.baseUrl }] },
  };
  await writeFile(configPath, JSON.stringify(document, null, 2));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_MAIN_KEY: 'main-synthetic', GRAPH_READER_KEY: 'reader-synthetic' }, extraArgs: ['--execute', '--dynamic'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  const reviewRequests = () => reader.requests.filter(request => {
    const body = request as { messages?: { role: string; content: unknown }[] };
    return body.messages?.some(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      try {
        const payload = JSON.parse(message.content) as { existingSkills?: unknown; reply?: unknown };
        return Array.isArray(payload.existingSkills) && typeof payload.reply === 'string';
      } catch { return false; }
    });
  });
  return { root, project, configPath, document, daemon, request, reader, reviewRequests };
}

test('sedimentation configuration survives actual saves and gates a real tool-turn review at the selected reader transport', async () => {
  const f = await fixture();
  const defaults: SedimentSettings = { enabled: false, afterToolCalls: 10, model: null, budgetTokens: 40000 };

  // The console shows the defaults before anybody touches the switch.
  const initial = await f.request('/api/config');
  expect(initial.status).toBe(200);
  expect((initial.body as { config: { skills: { sedimentation: SedimentSettings } } }).config.skills.sedimentation).toEqual(defaults);

  const created = await f.request('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'No tool work', requestId: 'no-tool' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  // A turn without tool work earns no review.
  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    const body = view.body as { messages?: { role: string; text: string }[] };
    return (body.messages ?? []).filter(message => message.role === 'assistant').length;
  }, { timeout: 30_000, interval: 250 }).toBe(1);
  expect(f.reviewRequests()).toHaveLength(0);

  // Turning the switch on is a real save, and the saved document keeps it.
  const firstSave = await f.request('/api/config', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: 0, document: { ...f.document, skills: { sedimentation: { enabled: true } } } }),
  });
  expect(firstSave.status, JSON.stringify(firstSave.body)).toBe(200);
  expect(firstSave.body as { applied?: boolean; effectiveRevision?: number }).toMatchObject({ applied: true, effectiveRevision: 1 });
  const snapshot = await f.request('/api/config');
  expect((snapshot.body as { config: { skills: { sedimentation: SedimentSettings } } }).config.skills.sedimentation)
    .toEqual({ ...defaults, enabled: true });
  // The document that comes back can be saved again unchanged.
  const roundTrip = await f.request('/api/config', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: 1, document: (snapshot.body as { config: unknown }).config }),
  });
  expect(roundTrip.status, JSON.stringify(roundTrip.body)).toBe(200);
  expect(roundTrip.body as { applied?: boolean; effectiveRevision?: number }).toMatchObject({ applied: true, effectiveRevision: 2 });

  // An invalid value is refused by name, and the file on disk is untouched.
  const original = await readFile(f.configPath, 'utf8');
  for (const [fields, field] of [
    [{ enabled: 'yes' }, 'enabled'], [{ afterToolCalls: 0 }, 'afterToolCalls'], [{ afterToolCalls: 2.5 }, 'afterToolCalls'],
    [{ budgetTokens: -1 }, 'budgetTokens'], [{ model: '   ' }, 'model'], [{ model: 'nobody' }, 'model'],
  ] as const) {
    const refused = await f.request('/api/config', {
      method: 'POST',
      body: JSON.stringify({ expectedRevision: 2, document: { ...f.document, skills: { sedimentation: fields } } }),
    });
    expect(refused.status, `${field} was not refused`).toBe(400);
    expect((refused.body as { message?: string }).message ?? '').toContain(`skills.sedimentation.${field}`);
    expect(await readFile(f.configPath, 'utf8')).toBe(original);
  }

  // The real settings: a threshold of one tool call, reviewed by the reader.
  const configured: SedimentSettings = { enabled: true, afterToolCalls: 1, model: 'reader', budgetTokens: 20000 };
  const applied = await f.request('/api/config', {
    method: 'POST',
    body: JSON.stringify({ expectedRevision: 2, document: { ...f.document, skills: { sedimentation: configured } } }),
  });
  expect(applied.status, JSON.stringify(applied.body)).toBe(200);
  expect(applied.body as { applied?: boolean; effectiveRevision?: number }).toMatchObject({ applied: true, effectiveRevision: 3 });
  const after = await f.request('/api/config');
  expect((after.body as { config: { skills: { sedimentation: SedimentSettings } } }).config.skills.sedimentation).toEqual(configured);

  // A turn that really uses a tool earns a review, on the reader model and
  // with the reader's own credential.
  const sent = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: 'Read the project lesson with your real tool', requestId: 'tool-turn' }),
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  await expect.poll(() => f.reviewRequests().length, { timeout: 30_000, interval: 250 }).toBe(1);
  const review = f.reviewRequests()[0]!;
  expect(review).toMatchObject({ model: 'reader-model' });
  expect(f.reader.authorizations[f.reader.requests.indexOf(review)]).toBe('Bearer reader-synthetic');
  expect(JSON.stringify(review)).toContain('Read the concrete project lesson');
}, 120_000);
