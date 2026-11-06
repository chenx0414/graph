import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { DEFINITION, masterProvider, run } from './go-graph-confirmation.fixture.ts';

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const item = record(value)[key];
  if (typeof item !== 'string' || !item) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return item;
}

test.each(['answer', 'manual-pause', 'delivery', 'estimated-usage', 'restart', 'restart-escalate'])('a graph worker question resumes correctly: %s', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-worker-question-'));
  const project = join(root, 'project');
  let questionID = '';
  let recoveryID = '';
  let recoveryUserAnswered = false;
  let graphID = '';
  let masterStarted = false;
  let releaseAnswer: () => void = () => {};
  const holdAnswer = new Promise<void>(resolve => { releaseAnswer = resolve; });
  const master = await masterProvider(body => body.tools?.some(tool => tool.function?.name === 'delegate_work') ? [{ id: mode === 'restart-escalate' && !recoveryUserAnswered ? 'escalate-recovery' : 'resolve-recovery', name: 'resolve_problem', args: () => mode === 'restart-escalate' && !recoveryUserAnswered ? ({ questionId: recoveryID, expectedRevision: 1, action: 'escalate', response: 'Did the interrupted call have side effects?', requestId: 'escalate-recovery' }) : ({ questionId: recoveryID, expectedRevision: mode === 'restart-escalate' ? 3 : 1, action: 'retry', proof: 'The interrupted fixture call performed no side effects.', requestId: 'resolve-recovery' }), before: async () => { await expect.poll(() => Boolean(recoveryID), { timeout: 20_000 }).toBe(true); } }] : [...(mode === 'delivery' ? [{ id: 'send-work', name: 'graph_send', args: () => ({ graphId: graphID, nodeId: 'a', input: 'in', value: { n: 7 } }), before: async () => { await expect.poll(() => Boolean(graphID), { timeout: 20_000 }).toBe(true); } }] : []), { id: 'resolve-node', name: 'resolve_problem', args: () => ({ questionId: questionID, expectedRevision: 1, action: 'respond', response: 'Use the project database.', requestId: 'resolve-node' }), before: async () => {
    await expect.poll(() => Boolean(questionID), { timeout: 20_000 }).toBe(true);
    masterStarted = true;
    await holdAnswer;
  } }]);
  const offered = new Set<string>();
  let workerRequests = 0;
  const worker = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = record(JSON.parse(Buffer.concat(chunks).toString()));
    workerRequests += 1;
    for (const tool of Array.isArray(body.tools) ? body.tools : []) {
      const name = record(record(tool).function).name;
      if (typeof name === 'string') offered.add(name);
    }
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const continued = JSON.stringify(messages).includes('Use the project database.');
    const submitted = JSON.stringify(messages).includes('"name":"submit"');
    if (continued && mode === 'delivery' && !submitted) {
      response.write(frame({ id: 'node', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'submit-result', type: 'function', function: { name: 'submit', arguments: JSON.stringify({ outputs: { out: { enable: true, value: { n: 42 } } } }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'node', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } else if (continued) {
      response.write(frame({ id: 'node', choices: [{ index: 0, delta: { role: 'assistant', content: 'Using the project database.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    } else {
      response.write(frame({ id: 'node', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'question', type: 'function', function: { name: 'ask_supervisor', arguments: JSON.stringify({ prompt: 'Which source should I use?', why: 'The input is ambiguous.', requestId: 'node-question' }) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'node', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], ...(mode === 'estimated-usage' ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5 } }) }));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address();
  if (!address || typeof address === 'string') throw new Error('Worker provider unavailable');
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    await mkdir(project);
    await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(project, 'README.md'), '# project\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) await run('git', args, { cwd: project });
    const configPath = join(root, 'graph.config.json');
    const common = { api: 'openai-completions', maxTokens: 256, credentialId: 'local', contextWindow: 32000 };
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_NODE_QUESTION_KEY' } }, models: { entries: [
      { ...common, id: 'main', provider: 'graph-master', grade: 'high', baseUrl: master.baseUrl },
      { ...common, id: 'sender', provider: 'graph-node', grade: 'medium', baseUrl: `http://127.0.0.1:${address.port}/v1` },
    ] } }));
    const start = () => launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_NODE_QUESTION_KEY: 'synthetic-key' } });
    daemon = await start();
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return record(value);
    }
    const conversation = field(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    const global = field(await request('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
    const definition = mode === 'delivery' ? { ...DEFINITION, nodes: { a: DEFINITION.nodes.a }, edges: {}, modules: {} } : DEFINITION;
    const graph = field(await request('/api/graphs', { conversationId: conversation, definition, targetBranch: 'main', requestId: 'graph' }), 'graphId');
    graphID = graph;
    if (mode === 'delivery') await request(`/api/conversations/${conversation}/messages`, { text: 'Send the input to the worker.', requestId: 'start-delivery' });
    else await request(`/api/tasks/${graph}/nodes/a/messages`, { text: 'Please clarify the data source.', requestId: 'node-input' });
    await expect.poll(() => workerRequests, { timeout: 20_000 }).toBeGreaterThan(0);
    await expect.poll(() => offered.has('ask_supervisor'), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => {
      const view = await request(`/api/tasks/${graph}`);
      const questions = Array.isArray(view.questions) ? view.questions : [];
      const question = questions.find(item => record(item).owner === 'main' && record(item).status === 'open');
      if (question) questionID = field(question, 'id');
      return Boolean(question);
    }, { timeout: 10_000 }).toBe(true);
    const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    const original = db.prepare("SELECT execution_id,queue_seq FROM node_questions WHERE question_id=?").get(questionID);
    db.close();
    expect(original).toBeDefined();
    const originalID = field(original, 'execution_id');
    const originalSeq = record(original).queue_seq;
    if (typeof originalSeq !== 'number') throw new Error('Missing original queue sequence');
    if (mode === 'estimated-usage') {
      const pending = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const calls = pending.prepare('SELECT id,state,usage FROM kernel_provider_calls WHERE execution_id=?').all(originalID);
      pending.close();
      expect(calls).toEqual([expect.objectContaining({ state: 'settled', usage: expect.stringContaining('"usageSource":"estimated"') })]);
    }
    if (mode === 'manual-pause') {
      await request(`/api/tasks/${graph}/graph/control`, { action: 'pause', nodeId: 'a' });
    }
    if (mode === 'restart' || mode === 'restart-escalate') {
      await expect.poll(() => masterStarted, { timeout: 10_000 }).toBe(true);
      const exited = once(daemon.child, 'exit');
      daemon.child.kill('SIGKILL');
      await exited;
      daemon = await start();
      const view = await request(`/api/tasks/${graph}`);
      expect(view.questions).toEqual(expect.arrayContaining([expect.objectContaining({ id: questionID, status: 'open' })]));
      const recovered = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      const recovery = recovered.prepare("SELECT id FROM questions WHERE kind='recovery' AND route_stage='global' AND status='open'").get();
      recovered.close();
      expect(recovery).toBeDefined();
      recoveryID = field(recovery, 'id');
      if (mode === 'restart-escalate') {
        await expect.poll(async () => {
          const view = await request(`/api/conversations/${global}`);
          return (Array.isArray(view.questions) ? view.questions : []).some(item => record(item).id === recoveryID && record(item).owner === 'user');
        }, { timeout: 15_000 }).toBe(true);
        const projectView = await request(`/api/conversations/${conversation}`);
        recoveryUserAnswered = true;
        await request(`/api/tasks/${field(projectView, 'anchorTaskId')}/answer`, { questionId: recoveryID, answer: { type: 'respond', value: 'No side effects; retry is safe.' }, requestId: 'recovery-user-answer' });
      }
    }
    releaseAnswer();
    await expect.poll(() => master.results.has('resolve-node'), { timeout: 20_000 }).toBe(true).catch(async () => {
      throw new Error(`project: ${JSON.stringify(await request(`/api/conversations/${conversation}`))}; graph: ${JSON.stringify(await request(`/api/tasks/${graph}`))}; master: ${JSON.stringify([...master.results])}; stderr: ${daemon?.stderr}`);
    });
    if (mode === 'restart' || mode === 'restart-escalate') {
      expect(master.results.get('resolve-recovery')).toContain('"resolved":true');
      if (mode === 'restart-escalate') expect(master.results.get('escalate-recovery')).toContain('"routeStage":"user"');
    }
    if (mode === 'manual-pause') {
      const before = workerRequests;
      await expect.poll(async () => {
        const view = await request(`/api/tasks/${graph}`);
        const questions = Array.isArray(view.questions) ? view.questions : [];
        return questions.some(question => record(question).status === 'resolved');
      }, { timeout: 10_000 }).toBe(true);
      expect(workerRequests).toBe(before);
      await request(`/api/tasks/${graph}/graph/control`, { action: 'resume', nodeId: 'a' });
    }
    await expect.poll(async () => JSON.stringify(await request(`/api/tasks/${graph}/nodes/a/run`)), { timeout: 20_000 }).toContain('Using the project database.');
    await expect.poll(() => {
      const current = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
      try { return record(current.prepare('SELECT state FROM kernel_executions WHERE id=?').get(originalID)).state; }
      finally { current.close(); }
    }, { timeout: 20_000 }).toBe('completed');
    const after = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true });
    const execution = after.prepare('SELECT id,state FROM kernel_executions WHERE id=?').get(originalID);
    const queued = after.prepare('SELECT state,generation FROM kernel_queue WHERE task_id=? AND seq=?').get(graph, originalSeq);
    const executions = after.prepare('SELECT COUNT(*) AS count FROM kernel_executions WHERE task_id=? AND node_id=?').get(graph, 'a');
    const node = after.prepare('SELECT node_paused,pause_since FROM kernel_nodes WHERE task_id=? AND node_id=?').get(graph, 'a');
    after.close();
    expect(execution).toMatchObject({ id: originalID, state: 'completed' });
    expect(queued).toMatchObject({ state: 'done', generation: 0 });
    expect(executions).toMatchObject({ count: 1 });
    expect(node).toMatchObject({ node_paused: 0, pause_since: null });
  } finally {
    releaseAnswer();
    await daemon?.close();
    await master.close();
    worker.closeAllConnections();
    await new Promise<void>(resolve => worker.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 60_000);
