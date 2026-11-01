import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A graph task waiting on a person must stop calling itself "blocked".
 *
 * `blocked` is the word for a runtime problem. A graph whose only remaining
 * acceptance criterion is a human one is not broken - it is waiting for the
 * person, and after the suspend deadline the task itself has to say so. The
 * conversation list got that word in the previous change; this case locks the
 * task surfaces: the task list the console reads, and the task entries inside
 * the conversation view.
 *
 * The graph is created through the console route (no planner turn), started by
 * main through the real graph_send tool, completed by main's own request, and
 * the human acceptance check is the product's own - nobody is asked by the test.
 */

interface ProviderTool { function?: { name?: string } }
interface ProviderBody { tools?: ProviderTool[]; messages?: { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }[] }

function git(cwd: string, args: string[]) {
  execFileSync('git', args, {
    cwd, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Graph Test', GIT_AUTHOR_EMAIL: 'graph@example.invalid',
      GIT_COMMITTER_NAME: 'Graph Test', GIT_COMMITTER_EMAIL: 'graph@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  });
}

const DEFINITION = {
  schemaVersion: 2,
  name: '人工验收的图',
  protocols: { job: { type: 'object' }, done: { type: 'object' } },
  nodes: {
    work: { recipe: 'coder@1', model: 'local', task: 'DO_THE_WORK', inputs: { in: { protocol: 'job' } }, outputs: { out: { protocol: 'done' } }, submission: { required: ['out'] } },
  },
  modules: {},
  edges: {},
  inputs: { start: { to: 'work.in', protocol: 'job' } },
  outputs: { done: { from: 'work.out', protocol: 'done' } },
  acceptance: [{ id: 'works', description: '由人确认这次工作', kind: 'human' }],
};

function graphProvider(graph: { id?: string }) {
  const requests: { master: boolean; body: ProviderBody }[] = [];
  let dispatched = false;
  let completionRequested = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'graph_send');
    requests.push({ master, body });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // Once the work landed, completing is main's explicit decision - the same
    // request a real supervisor makes; the acceptance check is evaluated then.
    if (master && graph.id && dispatched && !completionRequested) {
      completionRequested = true;
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'complete-graph', type: 'function',
        function: { name: 'graph_control', arguments: JSON.stringify({ graphId: graph.id, action: 'complete', requestId: 'await-complete' }) },
      }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    if (master && graph.id && !dispatched) {
      dispatched = true;
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
        index: 0, id: 'send-work', type: 'function',
        function: { name: 'graph_send', arguments: JSON.stringify({ graphId: graph.id, nodeId: 'work', input: 'in', value: { text: 'run the work' } }) },
      }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!master) {
      const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
      if (!submitted) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{
          index: 0, id: 'submit-work', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { text: 'work done' } } } }) },
        }] }, finish_reason: null }] }));
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
        response.end('data: [DONE]\n\n');
        return;
      }
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  return {
    requests,
    baseUrl: new Promise<string>(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/v1`))),
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface TaskQuestion { id: string; kind: string }

test('a graph task waiting on a person reports awaiting_user, not blocked', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-awaiting-user-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Awaiting user\n');
  git(project, ['init', '-q', '--template=', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const graph: { id?: string } = {};
  const provider = graphProvider(graph);
  const baseUrl = await provider.baseUrl;
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_AWAIT_KEY' } }, limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-await', grade: 'high',
        api: 'openai-completions', baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_AWAIT_KEY: 'synthetic-await-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }

    const created = await request('/api/conversations', 'POST', { projectId: 'p', model: 'local', text: 'Stand by.', requestId: 'await-conversation' });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    // Created through the console route: no planner turn, and no integration
    // branch, so the only thing the graph still needs is the person.
    const made = await request('/api/graphs', 'POST', { conversationId, definition: DEFINITION, requestId: 'await-graph' });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    graph.id = (made.body as { graphId: string }).graphId;
    expect(graph.id).toBeTruthy();
    const graphId = graph.id!;

    // A real message from the user is what makes main act: it dispatches the
    // work through its own graph_send tool.
    const sent = await request(`/api/conversations/${conversationId}/messages`, 'POST', { text: '开始跑这张图。', requestId: 'await-start' });
    expect(sent.status, JSON.stringify(sent.body)).toBe(200);

    const openHumanCheck = async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const tasks = ((view.body as { tasks?: { openQuestions?: TaskQuestion[] }[] }).tasks) ?? [];
      return tasks.flatMap(task => task.openQuestions ?? []).find(question => question.kind === 'human_check');
    };
    let sawQuestion = false;
    try {
      await expect.poll(async () => Boolean(await openHumanCheck()), { timeout: 90_000, interval: 250 }).toBe(true);
      sawQuestion = true;
    } catch { sawQuestion = false; }
    if (!sawQuestion) {
      const task = await request(`/api/tasks/${graphId}`);
      const events = await request(`/api/tasks/${graphId}/events?after=0&limit=200`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-30)
        .map((event: { cursor?: number; type?: string; data?: unknown }) => `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 180)}`);
      const calls = provider.requests.map(entry => `${entry.master ? 'main' : 'node'}`).join(',');
      expect(sawQuestion, `task: ${JSON.stringify(task.body).slice(0, 1200)}\nprovider: ${calls}\nevents:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe(true);
    }
    const question = await openHumanCheck();

    const taskStatus = async () => {
      const list = await request('/api/tasks');
      const rows = (Array.isArray(list.body) ? list.body : []) as { id: string; status: string }[];
      return rows.find(row => row.id === graphId)?.status;
    };
    const viewStatus = async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const tasks = ((view.body as { tasks?: { id: string; status: string }[] }).tasks) ?? [];
      return tasks.find(task => task.id === graphId)?.status;
    };
    // Before the deadline it is still an ordinary block.
    expect(await taskStatus()).toBe('blocked');
    expect(await viewStatus()).toBe('blocked');

    const db = new DatabaseSync(join(root, 'state/tasks.sqlite'));
    db.exec('PRAGMA busy_timeout=5000');
    db.prepare('UPDATE questions SET asked_at=? WHERE id=?').run(Date.now() - 60 * 60 * 1000, question!.id);
    db.close();

    await expect.poll(taskStatus, { timeout: 20000, interval: 250 }).toBe('awaiting_user');
    await expect.poll(viewStatus, { timeout: 20000, interval: 250 }).toBe('awaiting_user');
    // Still the person's to answer, and still present: the status is the only change.
    expect(Boolean(await openHumanCheck())).toBe(true);

    const answered = await request(`/api/tasks/${graphId}/answer`, 'POST', {
      questionId: question!.id, answer: { type: 'acknowledge' }, requestId: 'await-acknowledge',
    });
    expect(answered.status, JSON.stringify(answered.body)).toBe(200);
    await expect.poll(async () => (await taskStatus()) !== 'awaiting_user', { timeout: 30000, interval: 250 }).toBe(true);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
