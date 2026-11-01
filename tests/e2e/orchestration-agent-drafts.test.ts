import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { PROPOSAL } from './go-graph-confirmation.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object: ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function text(value: unknown, key: string): string {
  const result = object(value)[key];
  if (typeof result !== 'string' || !result) throw new Error(`Expected ${key}: ${JSON.stringify(value)}`);
  return result;
}

function result(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return result(JSON.parse(value));
  if (Array.isArray(value)) {
    for (const part of value) {
      const item = object(part);
      if (item.type === 'text' && typeof item.text === 'string') return result(item.text);
    }
    throw new Error(`Missing tool text: ${JSON.stringify(value)}`);
  }
  return object(value);
}

async function provider(source: Promise<string>) {
  const results = new Map<string, unknown>();
  const offers = new Set<string>();
  let projectAssignment = '';
  let projectSystem = '';
  let projectTools: { name: string; description: string }[] = [];
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      const messages = Array.isArray(body.messages) ? body.messages.map(object) : [];
      const offered = Array.isArray(body.tools) ? body.tools.map(object) : [];
      const described = offered.map(tool => object(tool.function))
        .filter(fn => typeof fn.name === 'string')
        .map(fn => ({ name: String(fn.name), description: typeof fn.description === 'string' ? fn.description : '' }));
      const systemText = messages.filter(message => message.role === 'system' || message.role === 'developer')
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? ''))
        .join('\n');
      for (const tool of offered) {
        const fn = object(tool.function);
        if (typeof fn.name === 'string') offers.add(fn.name);
      }
      const spoken = new Set<string>();
      for (const message of messages) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') results.set(message.tool_call_id, message.content);
        if (!Array.isArray(message.tool_calls)) continue;
        for (const raw of message.tool_calls) {
          const call = object(raw);
          if (typeof call.id === 'string') spoken.add(call.id);
        }
      }
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      const isProject = userText.includes('AGENT_DRAFT_PROJECT_381');
      const isGlobal = !isProject && userText.includes('AGENT_DRAFT_GLOBAL_381');
      if (isProject) { projectSystem = systemText; projectTools = described; }
      let call: { id: string; name: string; args: object } | undefined;
      const readyWork = /Project supervisor saved graph draft (\d+) for work ([a-f0-9-]+)/i.exec(userText);
      if (readyWork && !spoken.has('global-read')) {
        call = { id: 'global-read', name: 'read_work_draft', args: { workId: readyWork[2], version: Number(readyWork[1]) } };
      } else if (isProject && !spoken.has('project-draft')) {
        projectAssignment = userText;
        const workID = /工作 ID:\s*([a-f0-9-]+)/i.exec(userText)?.[1];
        const revision = /工作修订:\s*(\d+)/.exec(userText)?.[1];
        if (workID && revision) {
          call = { id: 'project-draft', name: 'propose_work_graph', args: {
            workId: workID, workRevision: Number(revision),
            proposal: { ...PROPOSAL, requirementVersion: Number(revision), summary: 'Search proposal' },
            requestId: 'project-draft-command',
          } };
        }
      } else if (isGlobal && !spoken.has('delegate-first')) {
        const sourceMessageId = await source;
        if (sourceMessageId) call = { id: 'delegate-first', name: 'delegate_work', args: {
          projectId: 'p', sourceMessageId, brief: 'AGENT_DRAFT_PROJECT_381: Search records',
          acceptance: ['Search shows matching records'], requestId: 'delegate-command',
        } };
      }
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (call) {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [
          { index: 0, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } },
        ] }, finish_reason: null }] }));
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
      } else {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Work received.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
      }
      response.end('data: [DONE]\n\n');
    } catch (error) {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Provider has no TCP address');
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`, results, offers,
    assignment: () => projectAssignment,
    system: () => projectSystem,
    tools: () => projectTools,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function read(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body;
}

test('the project supervisor creates a work-scoped graph draft from a global delegation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-agent-work-draft-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project);
  await writeFile(join(project, 'README.md'), '# project\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    execFileSync('git', args, { cwd: project });
  }
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  let releaseSource: ((id: string) => void) | undefined;
  const source = new Promise<string>(resolve => { releaseSource = resolve; });
  const model = await provider(source);
  cleanup.push(async () => { releaseSource?.(''); await model.close(); });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1, projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_AGENT_DRAFT_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: model.baseUrl, contextWindow: 32000, maxTokens: 2048, credentialId: 'local' }] },
  }));
  const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_AGENT_DRAFT_KEY: 'synthetic-key' } });
  cleanup.push(() => daemon.close());
  const post = async (path: string, body: object) => read(await daemon.request(path, { method: 'POST', body: JSON.stringify(body) }));
  await post('/api/projects/p/prepare', { requestId: 'prepare-project' });
  const global = text(await post('/api/orchestration/global', { requestId: 'open-global' }), 'conversationId');
  const message = await post(`/api/conversations/${global}/messages`, { text: 'AGENT_DRAFT_GLOBAL_381: Plan a search feature.', requestId: 'user-intent' });
  if (!releaseSource) throw new Error('Source promise not initialized');
  releaseSource(text(message, 'messageId'));

  await expect.poll(() => model.results.has('delegate-first'), { timeout: 30_000 }).toBe(true);
  const delegation = result(model.results.get('delegate-first'));
  const workID = text(delegation, 'workId');
  await expect.poll(() => model.results.has('project-draft'), { timeout: 30_000, message: `Project assignment: ${model.assignment()}` }).toBe(true);
  expect(model.offers.has('delegate_work')).toBe(true);
  expect(model.offers.has('propose_work_graph')).toBe(true);
  expect(model.assignment()).toContain(workID);
  expect(model.assignment()).toMatch(/工作修订:\s*1/);
  const projectContext = `${model.system()}\n${model.assignment()}`;
  expect(projectContext, 'the project supervisor prompt no longer asks for the graph shape')
    .toMatch(/decide the shape before the nodes/i);
  expect(projectContext).toMatch(/docs\/agent\/graph-v2\.md/);
  const workDraftTool = model.tools().find(tool => tool.name === 'propose_work_graph');
  expect(workDraftTool, 'the project supervisor is not offered propose_work_graph').toBeTruthy();
  expect(workDraftTool?.description, 'the work-graph drafting tool does not point at the shape document')
    .toMatch(/graph-v2\.md/);
  const draftReceipt = result(model.results.get('project-draft'));
  expect(draftReceipt).toMatchObject({ workId: workID, version: 1, workRevision: 1, proposal: { summary: 'Search proposal' } });

  await expect.poll(() => model.results.has('global-read'), { timeout: 30_000, message: 'Global supervisor did not read the project draft' }).toBe(true);
  const globalRead = result(model.results.get('global-read'));
  expect(globalRead).toMatchObject({ workId: workID, version: 1 });
  const drafts = object(await read(await daemon.request(`/api/orchestration/work/${workID}/drafts`))).items;
  if (!Array.isArray(drafts)) throw new Error('Draft list missing items');
  expect(drafts).toHaveLength(1);
  expect(drafts.map(object)).toEqual([expect.objectContaining({
    workId: workID, version: 1, workRevision: 1,
    proposal: expect.objectContaining({ summary: 'Search proposal', definition: PROPOSAL.definition }),
  })]);
}, 90_000);
