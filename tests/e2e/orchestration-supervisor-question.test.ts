import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== 'string' || !result) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return result;
}
function decoded(value: unknown): unknown {
  if (typeof value === 'string') return decoded(JSON.parse(value));
  if (Array.isArray(value) && value.length && typeof record(value[0]).text === 'string') return decoded(record(value[0]).text);
  return value;
}

test.each(['resolve', 'escalate', 'busy'])('a project question follows the global supervisor path: %s', async (mode) => {
  const root = await mkdtemp(join(tmpdir(), 'graph-supervisor-question-'));
  const results = new Map<string, unknown>();
  let userSubmitted = false;
  let globalStarted = false;
  let releaseGlobal: () => void = () => {};
  const globalHold = new Promise<void>(resolve => { releaseGlobal = resolve; });
  let release: () => void = () => {};
  const hold = new Promise<void>(resolve => { release = resolve; });
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = record(JSON.parse(Buffer.concat(chunks).toString()));
      const messages = Array.isArray(body.messages) ? body.messages.map(record) : [];
      const tools = Array.isArray(body.tools) ? body.tools.map(record) : [];
      const names = tools.map(item => record(item.function).name);
      for (const message of messages) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(message.tool_call_id, message.content);
      }
      const spoken = new Set(messages.flatMap(message => Array.isArray(message.tool_calls) ? message.tool_calls.map(call => record(call).id) : []));
      let call: { id: string; name: string; args: object } | undefined;
      const holdingGlobal = mode === 'busy' && names.includes('ask_user') && !globalStarted;
      if (holdingGlobal) {
        globalStarted = true;
        await globalHold;
      } else if (names.includes('ask_supervisor') && !spoken.has('ask-project')) {
        call = { id: 'ask-project', name: 'ask_supervisor', args: { prompt: 'Which source should I use?', why: 'I checked the project but could not choose.', options: ['API', 'Database'], requestId: 'ask-project' } };
      } else if (names.includes('ask_user') && !spoken.has('list-global')) {
        call = { id: 'list-global', name: 'list_problems', args: {} };
      } else if (names.includes('ask_user') && mode === 'escalate' && spoken.has('escalate-global') && userSubmitted && !spoken.has('list-after-user')) {
        call = { id: 'list-after-user', name: 'list_problems', args: {} };
      } else if (names.includes('ask_user') && !spoken.has('resolve-global') && results.has('list-global') && (mode !== 'escalate' || !spoken.has('escalate-global') || results.has('list-after-user'))) {
        await hold;
        const list = decoded(results.get(mode === 'escalate' && spoken.has('escalate-global') ? 'list-after-user' : 'list-global'));
        if (Array.isArray(list) && list.length) {
          const question = record(list[0]);
          if (!spoken.has('resolve-stale')) {
            call = { id: 'resolve-stale', name: 'resolve_problem', args: { questionId: question.id, expectedRevision: 999, action: 'respond', response: 'Stale answer', requestId: 'resolve-stale' } };
          } else if (mode === 'escalate' && !spoken.has('escalate-global')) {
            call = { id: 'escalate-global', name: 'resolve_problem', args: { questionId: question.id, expectedRevision: question.revision, action: 'escalate', response: 'Which database should we use?', requestId: 'escalate-global' } };
          } else {
            call = { id: 'resolve-global', name: 'resolve_problem', args: { questionId: question.id, expectedRevision: question.revision, action: 'respond', response: 'Use the project database.', requestId: 'resolve-global' } };
          }
        }
      }
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] }));
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      } else {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Understood.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      }
      response.end('data: [DONE]\n\n');
    } catch (error) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider did not bind');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    await mkdir(join(root, 'project'));
    await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }],
      credentials: { local: { secretRef: 'GRAPH_QUESTION_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: `http://127.0.0.1:${address.port}/v1`, contextWindow: 32000, maxTokens: 2048, credentialId: 'local' }] } }));
    const start = () => launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_QUESTION_KEY: 'synthetic-key' } });
    daemon = await start();
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return record(value);
    }
    const project = field(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    const global = field(await request('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
    if (mode === 'busy') {
      await request(`/api/conversations/${global}/messages`, { requestId: 'busy', text: 'Please consider this first.' });
      await expect.poll(() => globalStarted, { timeout: 30_000 }).toBe(true);
    }
    await request(`/api/conversations/${project}/messages`, { requestId: 'message', text: 'Plan an import.' });
    let questions: unknown[] = [];
    if (mode === 'busy') {
      await expect.poll(async () => {
        const view = await request(`/api/conversations/${project}`);
        return Array.isArray(view.questions) && view.questions.length === 1;
      }, { timeout: 30_000 }).toBe(true);
      releaseGlobal();
    }
    await expect.poll(() => results.has('list-global'), { timeout: 15_000 }).toBe(true);
    const waiting = await request(`/api/conversations/${project}`);
    const open = Array.isArray(waiting.questions) ? waiting.questions : [];
    expect(open).toHaveLength(1);
    const denied = await daemon.request(`/api/tasks/${field(waiting, 'anchorTaskId')}/answer`, { method: 'POST', body: JSON.stringify({
      questionId: field(open[0], 'id'), answer: { type: 'respond', value: 'Bypass' }, requestId: 'early-answer',
    }) });
    expect(denied.status).not.toBe(200);
    release();
    if (mode === 'escalate') {
      let userQuestions: unknown[] = [];
      await expect.poll(async () => {
        const view = await request(`/api/conversations/${global}`);
        userQuestions = Array.isArray(view.questions) ? view.questions.filter(item => record(item).status === 'open' && record(item).owner === 'user') : [];
        return userQuestions.length;
      }, { timeout: 15_000 }).toBe(1);
      expect(field(userQuestions[0], 'id')).toBe(field(open[0], 'id'));
      expect(record(record(userQuestions[0]).data)).toMatchObject({ options: [], multiple: false });
      expect((await request(`/api/conversations/${project}`)).questions).toEqual([]);
      await expect.poll(async () => record((await request(`/api/conversations/${global}`)).master).status, { timeout: 30_000 }).toBe('succeeded');
      await daemon.close();
      daemon = await start();
      const reopened = await request(`/api/conversations/${global}`);
      expect(reopened.questions).toEqual([expect.objectContaining({ id: field(userQuestions[0], 'id'), owner: 'user', status: 'open' })]);
      userSubmitted = true;
      await request(`/api/tasks/${field(waiting, 'anchorTaskId')}/answer`, { questionId: field(userQuestions[0], 'id'), answer: { type: 'respond', value: 'Use the project database.' }, requestId: 'user-answer' });
    }
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${project}`);
      questions = Array.isArray(view.questions) ? view.questions : [];
      return questions.length > 0 && record(questions[0]).status === 'resolved';
    }, { timeout: 30_000 }).toBe(true).catch(async () => {
      throw new Error(`Questions: ${JSON.stringify(questions)}, global: ${JSON.stringify(await request(`/api/conversations/${global}`))}, tool results: ${JSON.stringify([...results])}, stderr: ${daemon?.stderr}`);
    });
    expect(record(questions[0])).toMatchObject({ owner: 'main', answer: { type: 'respond', value: 'Use the project database.' } });
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${project}`);
      const messages = Array.isArray(view.messages) ? view.messages : [];
      return messages.some(message => record(message).role === 'assistant' && record(message).text === 'Understood.');
    }, { timeout: 30_000 }).toBe(true);
    expect(results.has('list-global')).toBe(true);
    expect(results.has('resolve-global')).toBe(true);
    expect(String(results.get('resolve-stale'))).toContain('question changed');
    if (mode === 'escalate') {
      const afterUser = decoded(results.get('list-after-user'));
      expect(afterUser).toEqual([expect.objectContaining({ id: field(questions[0], 'id'), revision: 3,
        data: expect.objectContaining({ userAnswer: 'Use the project database.', options: ['API', 'Database'], why: 'I checked the project but could not choose.' }) })]);
    }
  } finally {
    release();
    releaseGlobal();
    await daemon?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
