import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * A turn that cannot finish says so.
 *
 * When the model runs out of output budget the turn has to settle with a
 * notice the user can act on: the message stays, the user can send again or
 * switch models. The master must not stay dispatched, because a turn that
 * never settles is a turn the user cannot leave.
 *
 * The proof is the real daemon, the real model service and the real
 * conversation the user reads.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ConversationView {
  master?: { status?: string };
  messages?: { role: string; kind?: string; text: string; state?: string }[];
}

async function fixture(plans: (project: string) => Parameters<typeof openaiServer>[0]) {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-conversation-runtime-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await openaiServer(plans(project));
  cleanup.push(() => provider.close());
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_CONVERSATION_RUNTIME_KEY' } },
    models: { entries: [
      { id: 'main', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local',
        reasoning: true },
    ] },
  }, null, 2));
  const daemon = await launchCli(root, {
    configPath, env: { GRAPH_CONVERSATION_RUNTIME_KEY: 'synthetic-only' }, extraArgs: ['--execute'],
  });
  cleanup.push(() => daemon.close());
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as unknown };
  };
  return { project, provider, daemon, request };
}

test('an output-limit turn settles with a retry notice instead of staying in progress', async () => {
  // The model spends its whole answer on reasoning and stops on the output
  // limit: the reply never completes.
  const f = await fixture(() => [{
    thinking: 'This reasoning consumed the entire output budget. '.repeat(200),
    finishReason: 'length',
    usage: {
      prompt_tokens: 128,
      completion_tokens: 256,
      prompt_tokens_details: { cached_tokens: 0 },
      completion_tokens_details: { reasoning_tokens: 256 },
    },
  }]);
  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'main', text: '这个问题需要很长的思考。', requestId: 'output-limit-create' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;

  // The turn settles on its own: the daemon owes the user an answer, and a
  // truncated answer is still an answer.
  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    const body = view.body as ConversationView;
    return (body.messages ?? []).filter(message => message.role === 'system' && message.kind === 'error').length;
  }, { timeout: 30_000, interval: 250 }).toBe(1);

  const view = (await f.request(`/api/conversations/${conversationId}`)).body as ConversationView;
  const notice = (view.messages ?? []).find(message => message.role === 'system' && message.kind === 'error');
  expect(notice?.text).toContain('输出被截断');
  expect(notice?.state).toBe('done');
  // The turn is over: the master is not left dispatching forever.
  expect(view.master?.status).not.toBe('dispatched');
  const taskId = (created.body as { taskId: string }).taskId;
  const run = (await f.request(`/api/tasks/${taskId}/nodes/master/run`)).body as {
    operations?: { id: string; state: string; result?: { outcome?: string; output?: { error?: string } } }[];
    questions?: { id: string; kind: string; status: string }[];
  };
  // The operation settled, and what it settled with is the failure the user
  // was told about.
  expect(run.operations?.[0]?.state).toBe('succeeded');
  expect(run.operations?.[0]?.result?.outcome).toBe('failed');
  expect(run.operations?.[0]?.result?.output?.error).toContain('output token limit');
  // The failure belongs to the master itself, so it is parked: the master
  // waits for the user instead of failing the same way again on its own.
  expect(run.questions?.filter(question => question.kind === 'execution_failed' && question.status === 'open')).toHaveLength(1);
  // The user keeps the message they sent, and the truncated turn leaves no
  // answer pretending to be complete.
  expect((view.messages ?? []).filter(message => message.role === 'user')).toHaveLength(1);
  expect((view.messages ?? []).filter(message => message.role === 'assistant')).toHaveLength(0);
  // The provider really was asked, and it really did stop on the limit.
  expect(f.provider.requests).toHaveLength(1);
}, 60_000);

test('a tool-use response that keeps the connection open does not stall the following turn', async () => {
  const f = await fixture(project => [
    { finishReason: 'tool_calls', tools: ['1.png', '2.png', '3.png', '4.png'].map((name, index) => ({
      id: `read-image-${index}`, name: 'read', arguments: JSON.stringify({ path: join(project, name) }),
    })) },
    { text: 'First reply.' },
    // The publish asks for neither content nor a source path, so the tool
    // fails - and the provider keeps the connection open after the terminator.
    { thinking: 'I will publish the plan without supplying its content. '.repeat(100),
      finishReason: 'tool_calls',
      tools: [{ id: 'publish-without-content', name: 'artifact_publish',
        arguments: JSON.stringify({ namespace: 'plans', name: 'truncated-plan', requestId: 'truncated-plan-1' }) }],
      usage: { prompt_tokens: 128, completion_tokens: 256, prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 256 } },
      holdOpen: true },
    { text: 'The publish error was handled.' },
  ]);
  // Four reads in one turn: the tool results are big enough to matter and the
  // model has to answer after all of them.
  for (const name of ['1.png', '2.png', '3.png', '4.png']) {
    await writeFile(join(f.project, name), Buffer.alloc(512 * 1024, 7));
  }
  const provider = f.provider;

  const created = await f.request('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ projectId: 'p', model: 'main', text: '开始。', requestId: 'tool-limit-create' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = (created.body as { conversationId: string }).conversationId;
  const taskId = (created.body as { taskId: string }).taskId;

  // The first turn reads all four files and answers.
  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    const body = view.body as ConversationView;
    return (body.messages ?? []).filter(message => message.role === 'assistant').length;
  }, { timeout: 30_000, interval: 250 }).toBe(1);

  const sent = await f.request(`/api/conversations/${conversationId}/messages`, {
    method: 'POST', body: JSON.stringify({ text: '继续，按推荐处理。', requestId: 'tool-limit-follow-up' }),
  });
  expect(sent.status, JSON.stringify(sent.body)).toBe(200);
  // The held-open response must not hold the turn: the tool error is handled
  // and the model is asked again.
  await expect.poll(async () => {
    const view = await f.request(`/api/conversations/${conversationId}`);
    const body = view.body as ConversationView;
    return (body.messages ?? []).filter(message => message.role === 'assistant').length;
  }, { timeout: 30_000, interval: 250 }).toBe(2);

  const view = (await f.request(`/api/conversations/${conversationId}`)).body as ConversationView;
  expect((view.messages ?? []).filter(message => message.role === 'assistant').at(-1)?.text).toContain('publish error was handled');
  expect(view.master?.status).not.toBe('dispatched');
  // The truncated call is still recorded as the usage the provider reported.
  const run = (await f.request(`/api/tasks/${taskId}/nodes/master/run`)).body as {
    invocations?: { id: string; usageSource: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number } }[];
  };
  const truncated = (run.invocations ?? []).filter(invocation => invocation.usage?.output === 256);
  expect(truncated).toMatchObject([{
    usageSource: 'authoritative',
    usage: { input: 128, output: 256, cacheRead: 0, cacheWrite: 0 },
  }]);
  // The provider was asked four times: the reads, their answer, the failed
  // publish and the answer that handled it.
  expect(provider.requests).toHaveLength(4);
}, 90_000);
