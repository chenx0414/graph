import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { DEFINITION, run } from './go-graph-confirmation.fixture.ts';

function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function str(value: unknown, key: string): string {
  const result = obj(value)[key];
  if (typeof result !== 'string' || !result) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return result;
}

test('a node question travels through both supervisors and the user before resuming the node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-node-escalation-'));
  let questionID = '';
  let userAnswered = false;
  let projectEscalated = false;
  let globalEscalated = false;
  let globalResponded = false;
  let projectResponded = false;
  let releaseQuestion: () => void = () => {};
  const questionReady = new Promise<void>(resolve => { releaseQuestion = resolve; });
  const results = new Map<string, string>();
  const observed: string[][] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = obj(JSON.parse(Buffer.concat(chunks).toString()));
    const tools = Array.isArray(body.tools) ? body.tools.map(tool => str(obj(tool).function, 'name')) : [];
    observed.push(tools);
    const messages = Array.isArray(body.messages) ? body.messages.map(obj) : [];
    for (const message of messages) if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(message.tool_call_id, String(message.content));
    let call: { id: string; name: string; args: object } | undefined;
    let content = 'Understood.';
    if (tools.includes('ask_supervisor') && !tools.includes('ask_user') && tools.includes('graph_control')) {
      await questionReady;
      if (questionID && !projectEscalated) {
        projectEscalated = true;
        call = { id: 'project-escalate', name: 'resolve_problem', args: { questionId: questionID, expectedRevision: 1, action: 'escalate', response: 'The source requires a broader decision.', requestId: 'project-escalate' } };
      } else if (globalResponded && !projectResponded) {
        projectResponded = true;
        call = { id: 'project-answer', name: 'resolve_problem', args: { questionId: questionID, expectedRevision: 5, action: 'respond', response: 'Use the project database.', requestId: 'project-answer' } };
      }
    } else if (tools.includes('ask_user')) {
      if (projectEscalated && !globalEscalated) {
        globalEscalated = true;
        call = { id: 'global-escalate', name: 'resolve_problem', args: { questionId: questionID, expectedRevision: 2, action: 'escalate', response: 'Which source should be used?', requestId: 'global-escalate' } };
      } else if (userAnswered && !globalResponded) {
        globalResponded = true;
        call = { id: 'global-answer', name: 'resolve_problem', args: { questionId: questionID, expectedRevision: 4, action: 'respond', response: 'Use the project database.', requestId: 'global-answer' } };
      }
    } else if (tools.includes('ask_supervisor')) {
      if (JSON.stringify(messages).includes('Use the project database.')) content = 'Using the project database.';
      else call = { id: 'worker-question', name: 'ask_supervisor', args: { prompt: 'Which source should I use?', why: 'The source is ambiguous.', requestId: 'worker-question' } };
    }
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (call) {
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } else response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider unavailable');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const project = join(root, 'project');
    await mkdir(project); await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(project, 'README.md'), '# project\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) await run('git', args, { cwd: project });
    const configPath = join(root, 'graph.config.json');
    const common = { api: 'openai-completions', maxTokens: 256, credentialId: 'local', contextWindow: 32000, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_ESCALATION_KEY' } }, models: { entries: [
      { ...common, id: 'main', provider: 'graph-master', grade: 'high' }, { ...common, id: 'sender', provider: 'graph-node', grade: 'medium' },
    ] } }));
    daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_ESCALATION_KEY: 'synthetic-key' } });
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return obj(value);
    }
    const conversation = str(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    const global = str(await request('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
    const graph = str(await request('/api/graphs', { conversationId: conversation, definition: DEFINITION, targetBranch: 'main', requestId: 'graph' }), 'graphId');
    await request(`/api/tasks/${graph}/nodes/a/messages`, { text: 'Clarify the data source.', requestId: 'node-input' });
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${graph}`);
      const question = (Array.isArray(view.questions) ? view.questions : []).find(item => obj(item).status === 'open');
      if (question) { questionID = str(question, 'id'); releaseQuestion(); }
      return Boolean(questionID);
    }, { timeout: 15_000 }).toBe(true).catch(() => { throw new Error(`Escalation: ${JSON.stringify({ questionID, projectEscalated, globalEscalated, results: [...results], observed })}`); });
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${global}`);
      return (Array.isArray(view.questions) ? view.questions : []).some(item => obj(item).id === questionID && obj(item).owner === 'user');
    }, { timeout: 15_000 }).toBe(true).catch(() => { throw new Error(`Escalation: ${JSON.stringify({ questionID, projectEscalated, globalEscalated, results: [...results], observed })}`); });
    userAnswered = true;
    await request(`/api/tasks/${graph}/answer`, { questionId: questionID, answer: { type: 'respond', value: 'Use the project database.' }, requestId: 'user-answer' });
    await expect.poll(async () => JSON.stringify(await request(`/api/tasks/${graph}/nodes/a/run`)), { timeout: 20_000 }).toContain('Using the project database.');
    for (const id of ['project-escalate', 'global-escalate', 'global-answer', 'project-answer']) expect(results.get(id), id).toContain('"action"');
  } finally {
    releaseQuestion();
    await daemon?.close(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
