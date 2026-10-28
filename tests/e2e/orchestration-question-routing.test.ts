import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { masterProvider } from './go-graph-confirmation.fixture.ts';

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}

function string(value: unknown, key: string): string {
  const field = object(value)[key];
  if (typeof field !== 'string' || !field) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return field;
}

test('the global supervisor can ask the user a question', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-question-routing-'));
  const model = await masterProvider(() => [{ id: 'project-question', name: 'ask_user', args: {
    prompt: 'Which data source should this use?', why: 'The source determines the implementation.', requestId: 'ask-source',
  } }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    await mkdir(join(root, 'project'));
    await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }],
      credentials: { local: { secretRef: 'GRAPH_QUESTION_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: model.baseUrl, contextWindow: 32000, maxTokens: 2048, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_QUESTION_KEY: 'synthetic-key' } });
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return object(value);
    }
    const global = string(await request('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
    await request(`/api/conversations/${global}/messages`, { requestId: 'message', text: 'Plan a data import.' });
    let questions: unknown[] = [];
    let lastView: Record<string, unknown> = {};
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${global}`);
      lastView = view;
      questions = Array.isArray(view.questions) ? view.questions : [];
      return questions.length;
    }, { timeout: 10_000 }).toBeGreaterThan(0).catch(() => {
      throw new Error(`global view: ${JSON.stringify(lastView)}, model turns: ${model.turns()}, tool results: ${JSON.stringify([...model.results])}`);
    });
    expect(object(questions[0]).owner).toBe('user');
    expect(model.turns()).toBe(1);
    await request(`/api/tasks/${string(lastView, 'anchorTaskId')}/answer`, {
      questionId: string(questions[0], 'id'), answer: { type: 'respond', value: 'Use the project database.' }, requestId: 'answer-source',
    });
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${global}`);
      const items = Array.isArray(view.questions) ? view.questions : [];
      return items.some(item => object(item).status === 'resolved');
    }, { timeout: 10_000 }).toBe(true);
    await expect.poll(() => model.turns(), { timeout: 10_000 }).toBeGreaterThan(1);
  } finally {
    await daemon?.close();
    await model.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
