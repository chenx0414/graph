import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { PROPOSAL } from './go-graph-confirmation.fixture.ts';

/**
 * A draft a supervisor cannot read says which of the four ways it cannot.
 *
 * "Work draft not found" covered an unknown work, a version that never existed,
 * a version that was archived, and a thread that does not supervise this work.
 * An Agent reading that one sentence can only retry the identical call: it
 * cannot tell "ask the user for the right work", "read another version",
 * "restore the draft" from "you are in the wrong thread".
 *
 * Each refusal is now its own code, and the code is what these cases read - the
 * three that answer over HTTP by `body.code`, and the permission one by the code
 * that leads the tool result text a model reads (a tool result carries no code
 * field, so the code is the first token of the message).
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

/**
 * One scripted master. It answers a turn that asks for the other supervisor's
 * draft with the read call, and everything else with plain text.
 */
async function masterModel(otherWork: () => string) {
  const results = new Map<string, string>();
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    const messages = body.messages ?? [];
    for (const message of messages) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set(messages.flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const lastUser = [...messages].reverse().find(message => message.role === 'user');
    const userText = typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const say = (delta: unknown, finish: string | null) => response.write(frame({
      id: 'r', choices: [{ index: 0, delta, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 5 },
    }));
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const offered = body.tools ?? [];
    if (userText.includes('P5B_READ_OTHER') && offered.length && !spoken.has('read-other')) {
      const args = { workId: otherWork(), version: 1 };
      say({ role: 'assistant', tool_calls: [{ index: 0, id: 'read-other', type: 'function',
        function: { name: 'read_work_draft', arguments: JSON.stringify(args) } }] }, null);
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: {} }));
    } else {
      say({ role: 'assistant', content: 'Noted.' }, 'stop');
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    results,
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

test('an unreadable work draft names which of the four ways it is unreadable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-work-draft-refusal-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# project\n');
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

  // The work the global supervisor does not own: it belongs to the project
  // thread, so the global thread may not read its draft.
  let foreignWork = '';
  const master = await masterModel(() => foreignWork);

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'drafts' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { drafts: { secretRef: 'GRAPH_DRAFTS_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
      ] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_DRAFTS_KEY: 'drafts-synthetic' }, extraArgs: ['--execute'] });
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await daemon!.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
    };
    const post = async (path: string, body: object) => {
      const answered = await request(path, { method: 'POST', body: JSON.stringify(body) });
      expect(answered.status, JSON.stringify(answered.body)).toBe(200);
      return answered.body;
    };

    await post('/api/projects/p/prepare', { requestId: 'prepare' });
    const global = (await post('/api/orchestration/global', { requestId: 'global' })).conversationId as string;
    const message = async (conversationId: string, text: string, requestId: string) =>
      (await post(`/api/conversations/${conversationId}/messages`, { text, requestId })).messageId as string;
    const createWork = async (conversationId: string, requestId: string) => (await post('/api/orchestration/work', {
      requestId, conversationId, projectId: 'p', sourceMessageId: await message(conversationId, `Build ${requestId}`, `text-${requestId}`),
      brief: `Build ${requestId}`, acceptance: [`${requestId} works`],
    })).id as string;

    const work = await createWork(global, 'owned');
    const draft = await post(`/api/orchestration/work/${work}/drafts`, { requestId: 'draft-1', workRevision: 1, proposal: PROPOSAL });
    expect(draft).toMatchObject({ workId: work, version: 1 });

    // 1. No such work at all.
    const unknownWork = await request('/api/orchestration/work/3f2504e0-4f89-41d3-9a0c-0305e82c3301/drafts/1');
    expect(unknownWork.body.code, JSON.stringify(unknownWork.body)).toBe('work_not_found');

    // 2. The work exists and that version does not. The refusal names what does.
    const unknownVersion = await request(`/api/orchestration/work/${work}/drafts/2`);
    expect(unknownVersion.body.code, JSON.stringify(unknownVersion.body)).toBe('draft_version_not_found');
    expect(unknownVersion.body.message).toContain('versions are 1');

    // 3. The version exists, archived: it is not deleted and not missing, and the
    // list of archived drafts still shows it.
    const archived = await post(`/api/orchestration/work/${work}/drafts/1/archive`, { requestId: 'archive-1', expectedDraftRevision: 1 });
    expect(archived).toMatchObject({ archived: true });
    const archivedRead = await request(`/api/orchestration/work/${work}/drafts/1`);
    expect(archivedRead.body.code, JSON.stringify(archivedRead.body)).toBe('draft_archived');
    const archivedList = await request(`/api/orchestration/work/${work}/drafts?archived=true`);
    expect((archivedList.body.items as { version: number; archived: boolean }[]).map(item => [item.version, item.archived]))
      .toEqual([[1, true]]);

    // 4. Somebody else's work: a permission, never "not found".
    const thread = (await post('/api/projects/p/thread', { requestId: 'project-thread' })).conversationId as string;
    foreignWork = await createWork(thread, 'foreign');
    await post(`/api/orchestration/work/${foreignWork}/drafts`, { requestId: 'foreign-draft', workRevision: 1, proposal: PROPOSAL });
    await post(`/api/conversations/${global}/messages`, { text: 'P5B_READ_OTHER: read that draft', requestId: 'read-other' });
    await expect.poll(() => master.results.get('read-other'), { timeout: 120_000, interval: 250 }).toBeTruthy();
    const refusal = master.results.get('read-other') ?? '';
    expect(refusal).toContain('permission');
    expect(refusal).toContain('another supervisor');
    // The four ways are four answers: this one is not the not-found.
    expect(refusal).not.toContain('draft_version_not_found');
    expect(refusal).not.toContain('work_not_found');
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
