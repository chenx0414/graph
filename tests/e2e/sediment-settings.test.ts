import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

test('sedimentation configuration survives actual saves and gates a real tool-turn review at the selected reader transport', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-sediment-settings-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'lesson.txt'), 'A concrete lesson from the user project.');
  const mainServer = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { tools?: unknown[]; messages: { role: string; content: unknown }[] };
    const last = body.messages.at(-1);
    const user = [...body.messages].reverse().find(message => message.role === 'user');
    const read = Boolean(body.tools?.length) && last?.role === 'user' && JSON.stringify(user?.content).includes('Read the project lesson');
    const delta = read ? { role: 'assistant', tool_calls: [{ index: 0, id: 'read-lesson', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'lesson.txt' }) } }] }
      : { role: 'assistant', content: body.tools?.length && last?.role === 'tool' ? 'Read the concrete project lesson' : 'No tools yet' };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: read ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 10 } })}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => mainServer.listen(0, '127.0.0.1', resolve));
  const provider = { model: { baseUrl: `http://127.0.0.1:${(mainServer.address() as AddressInfo).port}/v1` }, async close() { mainServer.closeAllConnections(); await new Promise<void>(resolve => mainServer.close(() => resolve())); } };
  const reader = await openaiServer([{ text: '{"action":"nothing","id":"lesson","reason":"Nothing reusable"}' }]);
  cleanup.push(() => provider.close(), () => reader.close());
  const reviewRequests = () => reader.requests.filter(request => {
    const body = request as { messages?: { role: string; content: unknown }[] };
    return body.messages?.some(message => {
      if (message.role !== 'user' || typeof message.content !== 'string') return false;
      try { const payload = JSON.parse(message.content); return Array.isArray(payload.existingSkills) && typeof payload.reply === 'string'; } catch { return false; }
    });
  });
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const entry = { id: 'main', provider: 'graph-main', modelId: 'main-model', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'main' };
  const configPath = join(root, 'graph.config.json');
  const initial = { version: 1, projects: [{ id: 'p', root: project }], credentials: { main: { secretRef: 'GRAPH_MAIN_KEY' }, reader: { secretRef: 'GRAPH_READER_KEY' } }, models: { entries: [entry, { ...entry, id: 'reader', provider: 'graph-reader', modelId: 'reader-model', grade: 'low', credentialId: 'reader', baseUrl: reader.model.baseUrl }] } };
  await writeFile(configPath, JSON.stringify(initial));
  const daemon = await startGraphDaemon({ configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir, port: 0, mode: 'execute', dynamic: true, env: { HOME: root, GRAPH_MAIN_KEY: 'main-synthetic', GRAPH_READER_KEY: 'reader-synthetic' }, log: () => undefined });
  cleanup.push(() => daemon.close());
  const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
  const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
  const get = async (path: string) => (await fetch(`${daemon.url}${path}`, { headers })).json();
  const post = (path: string, body: unknown) => fetch(`${daemon.url}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const defaults = { enabled: false, afterToolCalls: 10, model: null, budgetTokens: 40000 };
  expect((await get('/api/config')).config.skills.sedimentation).toEqual(defaults);
  const createdResponse = await post('/api/conversations', { projectId: 'p', model: 'main', text: 'No tool work', requestId: 'no-tool' });
  const created = await createdResponse.json() as { conversationId: string; taskId: string };
  await expect.poll(async () => (await get(`/api/tasks/${created.taskId}`)).invocations[0]?.cost, { timeout: 20000 }).toEqual({ unknown: true });
  expect(reviewRequests()).toHaveLength(0);
  const firstSave = await post('/api/config', { expectedRevision: 0, document: { ...initial, skills: { sedimentation: { enabled: true } } } });
  expect(await firstSave.json()).toMatchObject({ applied: true, effectiveRevision: 1 });
  const snapshot = await get('/api/config');
  expect(snapshot.config.skills.sedimentation).toEqual({ ...defaults, enabled: true });
  const roundTrip = await post('/api/config', { expectedRevision: 1, document: snapshot.config });
  expect(await roundTrip.json()).toMatchObject({ applied: true, effectiveRevision: 2 });
  const original = await readFile(configPath, 'utf8');
  for (const [fields, field] of [
    [{ enabled: 'yes' }, 'enabled'], [{ afterToolCalls: 0 }, 'afterToolCalls'], [{ afterToolCalls: 2.5 }, 'afterToolCalls'],
    [{ budgetTokens: -1 }, 'budgetTokens'], [{ model: '   ' }, 'model'], [{ model: 'nobody' }, 'model'],
  ] as const) {
    const response = await post('/api/config', { expectedRevision: 2, document: { ...initial, skills: { sedimentation: fields } } });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain(`skills.sedimentation.${field}`);
    expect(await readFile(configPath, 'utf8')).toBe(original);
  }
  const configured = { enabled: true, afterToolCalls: 1, model: 'reader', budgetTokens: 20000 };
  expect(await (await post('/api/config', { expectedRevision: 2, document: { ...initial, skills: { sedimentation: configured } } })).json()).toMatchObject({ applied: true, effectiveRevision: 3 });
  expect((await get('/api/config')).config.skills.sedimentation).toEqual(configured);
  const sent = await post(`/api/conversations/${created.conversationId}/messages`, { text: 'Read the project lesson with your real tool', requestId: 'tool-turn' });
  expect(sent.status).toBe(200);
  await expect.poll(() => reviewRequests().length, { timeout: 20000 }).toBe(1);
  const review = reviewRequests()[0];
  expect(review).toMatchObject({ model: 'reader-model' });
  expect(reader.authorizations[reader.requests.indexOf(review)]).toBe('Bearer reader-synthetic');
  expect(JSON.stringify(review)).toContain('Read the concrete project lesson');
}, 90_000);
