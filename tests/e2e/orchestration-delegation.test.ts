import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

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

function textField(value: unknown, key: string): string {
  const field = object(value)[key];
  if (typeof field !== 'string' || !field) throw new Error(`Expected ${key}: ${JSON.stringify(value)}`);
  return field;
}

function receipt(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') return receipt(JSON.parse(value));
  if (Array.isArray(value)) {
    for (const part of value) {
      const entry = object(part);
      if (entry.type === 'text' && typeof entry.text === 'string') return receipt(entry.text);
    }
    throw new Error(`Tool response contains no text: ${JSON.stringify(value)}`);
  }
  return object(value);
}

const globalPrompt = 'GLOBAL_INTENT_982: Please plan the project search feature.';
const brief = 'PROJECT_ASSIGNMENT_982: Search records by title';
const criterion = 'Show matching records after a search';

async function scriptedProvider(source: Promise<string>) {
  const toolResults = new Map<string, unknown>();
  const projectRequests: string[] = [];
  let globalOfferedDelegate = false;
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = object(JSON.parse(Buffer.concat(chunks).toString()));
      const messages = Array.isArray(body.messages) ? body.messages.map(object) : [];
      for (const message of messages) {
        if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
          toolResults.set(message.tool_call_id, message.content);
        }
      }
      const lastUser = [...messages].reverse().find(message => message.role === 'user');
      const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
      const project = userText.includes('PROJECT_ASSIGNMENT_982');
      const global = !project && userText.includes('GLOBAL_INTENT_982');
      const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      if (project) {
        projectRequests.push(JSON.stringify(body.messages));
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Project supervisor received the assignment.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
      } else if (global) {
        const offered = Array.isArray(body.tools) ? body.tools.map(object) : [];
        globalOfferedDelegate ||= offered.some(tool => {
          const fn = tool.function;
          return typeof fn === 'object' && fn !== null && 'name' in fn && fn.name === 'delegate_work';
        });
        const spoken = new Set<string>();
        for (const message of messages) {
          if (!Array.isArray(message.tool_calls)) continue;
          for (const rawCall of message.tool_calls) {
            const call = object(rawCall);
            if (typeof call.id === 'string') spoken.add(call.id);
          }
        }
        const callId = !spoken.has('delegate-first') ? 'delegate-first' : !spoken.has('delegate-retry') ? 'delegate-retry' : '';
        if (callId) {
          const sourceMessageId = await source;
          if (!sourceMessageId) { response.end(); return; }
          const args = { projectId: 'p', sourceMessageId, brief, acceptance: [criterion], requestId: 'same-delegation' };
          response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: callId, type: 'function', function: { name: 'delegate_work', arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
          response.write(frame({ id: 'reply', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
        } else {
          response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'The assignment was delivered.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
        }
      } else {
        response.write(frame({ id: 'reply', choices: [{ index: 0, delta: { role: 'assistant', content: 'Standing by.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 8 } }));
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
    baseUrl: `http://127.0.0.1:${address.port}/v1`, toolResults, projectRequests,
    offeredDelegate: () => globalOfferedDelegate,
    async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

async function read(response: Response): Promise<unknown> {
  const data: unknown = await response.json();
  expect(response.status, JSON.stringify(data)).toBe(200);
  return data;
}

function transcript(value: unknown): Record<string, unknown>[] {
  const messages = object(value).messages;
  if (!Array.isArray(messages)) throw new Error(`Expected messages: ${JSON.stringify(value)}`);
  return messages.map(object);
}

test('the global supervisor delegates one work item to the project supervisor and retries without duplication', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-orchestration-delegation-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await writeFile(join(root, 'project', 'README.md'), '# project\n');
  for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'],
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) {
    execFileSync('git', args, { cwd: join(root, 'project') });
  }
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  let releaseSource: ((id: string) => void) | undefined;
  const source = new Promise<string>(resolve => { releaseSource = resolve; });
  const provider = await scriptedProvider(source);
  cleanup.push(async () => { releaseSource?.(''); await provider.close(); });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: join(root, 'project') }],
    credentials: { local: { secretRef: 'GRAPH_DELEGATION_TEST_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 1024, credentialId: 'local' }] },
  }));
  const start = async () => {
    const daemon = await launchCli(root, { configPath, extraArgs: ['--execute'], env: { GRAPH_DELEGATION_TEST_KEY: 'synthetic-delegation-key' } });
    cleanup.push(() => daemon.close());
    return daemon;
  };
  let daemon = await start();
  const post = async (path: string, body: object) => read(await daemon.request(path, { method: 'POST', body: JSON.stringify(body) }));
  await post('/api/projects/p/prepare', { requestId: 'prepare-project' });
  const global = textField(await post('/api/orchestration/global', { requestId: 'open-global' }), 'conversationId');
  const submitted = await post(`/api/conversations/${global}/messages`, { text: globalPrompt, requestId: 'user-intent' });
  const messageID = textField(submitted, 'messageId');
  if (!releaseSource) throw new Error('Model source promise was not initialized');
  releaseSource(messageID);

  await expect.poll(() => provider.toolResults.has('delegate-first') && provider.toolResults.has('delegate-retry'), { timeout: 30_000 })
    .toBe(true);
  expect(provider.offeredDelegate()).toBe(true);
  const first = receipt(provider.toolResults.get('delegate-first'));
  const retry = receipt(provider.toolResults.get('delegate-retry'));
  const workID = textField(first, 'workId');
  const projectConversation = textField(first, 'conversationId');
  const message = textField(first, 'messageId');
  expect(first.projectId).toBe('p');
  expect(retry).toMatchObject({ workId: workID, conversationId: projectConversation, messageId: message });

  const work = object(await read(await daemon.request(`/api/orchestration/work/${workID}`)));
  expect(work).toMatchObject({ id: workID, projectId: 'p', conversationId: global, sourceMessageId: messageID });
  const projectMessages = async () => transcript(await read(await daemon.request(`/api/conversations/${projectConversation}`)));
  await expect.poll(async () => (await projectMessages()).some(item => item.role === 'assistant' && item.text === 'Project supervisor received the assignment.'), { timeout: 30_000 })
    .toBe(true);
  const assignment = (await projectMessages()).filter(item => item.id === message);
  expect(assignment).toHaveLength(1);
  const delivered = assignment[0];
  if (!delivered) throw new Error('Project assignment is absent');
  expect(delivered.text).toContain(brief);
  expect(delivered.text).toContain(workID);
  expect(object(object(delivered.data).source)).toMatchObject({ kind: 'agent', conversationId: global });
  expect(provider.projectRequests.some(value => value.includes(brief) && value.includes(criterion) && value.includes(workID))).toBe(true);
  const listed = object(await read(await daemon.request('/api/orchestration/work?projectId=p'))).items;
  if (!Array.isArray(listed)) throw new Error('Work list missing items');
  expect(listed.map(object).filter(item => item.id === workID)).toHaveLength(1);

  await daemon.close();
  daemon = await start();
  const reopened = await post('/api/projects/p/thread', { requestId: 'reopen-after-restart' });
  expect(textField(reopened, 'conversationId')).toBe(projectConversation);
  expect(object(await read(await daemon.request(`/api/orchestration/work/${workID}`)))).toMatchObject({ id: workID, sourceMessageId: messageID });
  expect((await projectMessages()).filter(item => item.id === message)).toHaveLength(1);
}, 90_000);
