import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The main Agent asking the host to change, and a person deciding.
 *
 * The main Agent may ask for a change to the Graph it runs on - a capability
 * the library is missing, a rule that should exist. Whether the change happens
 * right away or waits for a person is the host's access policy: a host that
 * let its Agent rewrite itself without asking could not keep any promise it
 * made, and a host that asks about every change is unusable. Either way only
 * an approved proposal is ever applied, and the applied change is a real file
 * in the capability library.
 *
 * The health view is the other half: the main Agent may look at what is wrong
 * with its own conversation - the problems nobody answered, the nodes that
 * failed - and it sees that conversation only.
 *
 * The proof is the real daemon: the question really lands in the user's inbox,
 * the capability really is not installed before the answer, and the capability
 * really is installed after it.
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }

/** The change the main Agent asks for: one MCP capability for the library. */
const CAPABILITY_CHANGE = {
  kind: 'capability',
  capability: {
    manifest: {
      id: 'semantic-scholar', kind: 'mcp', version: '1.0.0', name: 'Semantic Scholar',
      description: 'Semantic Scholar MCP', url: 'https://example.test/mcp',
    },
  },
};

/** The tool answers of one request, in the order the model asked for them. */
function toolAnswers(body: ChatBody | undefined): any[] {
  const answers: any[] = [];
  for (const message of body?.messages ?? []) {
    if (message.role !== 'tool') continue;
    try { answers.push(JSON.parse(String(message.content ?? '{}')) as any); }
    catch { /* a tool that answered with text, not with a document */ }
  }
  return answers;
}

/** The raw tool answers of one request, in the order the model asked for them. */
function toolTexts(body: ChatBody | undefined): string[] {
  return (body?.messages ?? [])
    .filter(message => message.role === 'tool')
    .map(message => String(message.content ?? ''));
}

/**
 * A provider that plays the self-improvement script.
 *
 * It looks at the host, it proposes the change, and it waits - until the
 * person has answered, which `approved` reports. Only then does it apply.
 */
async function selfImprovementProvider(approved: () => boolean, proposalId: () => Promise<string>) {
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking: it is the master
    // asking for a next-message suggestion.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const call = (id: string, name: string, args: unknown) => {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    const text = (content: string) => {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    if (!spoken.has('inspect')) { call('inspect', 'inspect_graph_system', {}); return; }
    if (!spoken.has('propose')) {
      call('propose', 'propose_system_change', {
        title: '安装 Semantic Scholar MCP',
        problem: '资源库中缺少 Semantic Scholar MCP，文献检索只能依赖普通 Skill。',
        changeJson: JSON.stringify(CAPABILITY_CHANGE),
        impact: '后续 Agent 配方可以直接绑定该 MCP。',
        risk: '首次启动 MCP 时需要允许下载对应包。',
      });
      return;
    }
    if (!approved()) {
      // An unapproved proposal must not be applied, not even by the Agent that
      // proposed it.
      if (!spoken.has('try-apply')) { call('try-apply', 'apply_system_change', { proposalId: await proposalId() }); return; }
      text('已提交系统优化，等待你批准。');
      return;
    }
    if (!spoken.has('apply')) {
      // The proposal id belongs to the question the proposal became.
      call('apply', 'apply_system_change', { proposalId: await proposalId() });
      return;
    }
    text('已安装。');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface ConversationQuestion {
  id: string;
  kind: string;
  status: string;
  owner: string;
  data?: { proposalId?: string; title?: string; change?: { kind?: string } };
}
interface ConversationView {
  anchorTaskId?: string;
  questions?: ConversationQuestion[];
  messages?: { role?: string; text?: string }[];
}

async function fixture(prefix: string, options: { access?: unknown; autoApproved?: boolean } = {}) {
  let approved = options.autoApproved ?? false;
  let conversationId = '';
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const provider = await selfImprovementProvider(() => approved, async () => {
    if (!conversationId || !daemon) return '';
    const response = await daemon.request(`/api/conversations/${conversationId}`);
    const body = await response.json().catch(() => ({})) as ConversationView;
    const question = body.questions?.find(candidate => candidate.kind === 'system_change');
    return question?.data?.proposalId ?? '';
  });
  cleanup.push(() => provider.close());
  const root = await mkdtemp(join(tmpdir(), `graph-e2e-go-system-change-${prefix}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const graphHome = join(root, 'graph-home');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] },
    ...(options.access ? { access: options.access } : {}),
  }));
  daemon = await launchCli(root, {
    configPath, env: { GRAPH_LOCAL_KEY: 'key-local' }, extraArgs: ['--execute', '--kernel', 'pig'],
  });
  cleanup.push(() => daemon.close());
  const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
    const response = await daemon.request(path, init);
    const body = await response.json().catch(() => ({})) as T;
    return { status: response.status, body };
  };
  const view = async (id: string) => (await request<ConversationView>(`/api/conversations/${id}`)).body;
  return {
    root, graphHome, provider, daemon, request, view,
    remember: (id: string) => { conversationId = id; },
    capabilityDirectory: join(graphHome, 'capabilities', 'mcp', 'semantic-scholar-1.0.0'),
    approve: () => { approved = true; },
  };
}

/** The catalog the daemon serves: which capabilities the library holds. */
async function capabilityIds(f: { request: <T>(path: string, init?: RequestInit) => Promise<{ status: number; body: T }> }) {
  const catalog = await f.request<{ capabilities?: { id: string; status: string }[] }>('/api/catalog');
  return (catalog.body.capabilities ?? []).map(capability => capability.id);
}

test('a system change waits for the user, and the approved change really lands', async () => {
  const f = await fixture('approval', { access: { mode: 'standard' } });

  const created = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: '把 Semantic Scholar MCP 加进资源库。', requestId: 'system-change' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  const conversationId = created.body.conversationId;
  f.remember(conversationId);

  // The proposal is a question for the user, not a change.
  await expect.poll(async () => {
    const view = await f.view(conversationId);
    return view.questions?.find(question => question.kind === 'system_change')?.status;
  }, { timeout: 60_000, interval: 250 }).toBe('open');
  const view = await f.view(conversationId);
  const proposal = view.questions?.find(question => question.kind === 'system_change');
  expect(proposal, JSON.stringify(view.questions)).toBeTruthy();
  expect(proposal!.owner).toBe('user');
  expect(proposal!.data?.title).toBe('安装 Semantic Scholar MCP');
  expect(proposal!.data?.change?.kind).toBe('capability');
  // Nothing was installed: the proposal is only a proposal. The Agent tried to
  // apply it anyway, and the host refused - only an approved proposal lands.
  const attempts = toolTexts(f.provider.requests.filter(body => (body.tools ?? []).length).at(-1));
  expect(attempts.join('\n')).toContain('has not been approved by the user');
  expect(existsSync(f.capabilityDirectory)).toBe(false);
  expect(await capabilityIds(f)).not.toContain('semantic-scholar');

  // The person answers: the change is approved.
  const answered = await f.request(`/api/tasks/${view.anchorTaskId}/answer`, {
    method: 'POST', body: JSON.stringify({
      questionId: proposal!.id,
      answer: { type: 'respond', value: { decision: 'approved', proposalId: proposal!.data?.proposalId } },
      requestId: 'approve-system-change',
    }),
  });
  expect(answered.status, JSON.stringify(answered.body)).toBe(200);
  f.approve();

  // The approved change really lands: the capability is in the library.
  await expect.poll(async () => existsSync(f.capabilityDirectory), { timeout: 60_000, interval: 250 }).toBe(true);
  const manifest = JSON.parse(await readFile(join(f.capabilityDirectory, 'capability.json'), 'utf8')) as { id: string; kind: string };
  expect(manifest.id).toBe('semantic-scholar');
  expect(manifest.kind).toBe('mcp');
  await expect.poll(async () => (await capabilityIds(f)).includes('semantic-scholar'), { timeout: 30_000, interval: 250 }).toBe(true);

  // And the question that asked for it is closed.
  const settled = await f.view(conversationId);
  expect(settled.questions?.find(question => question.id === proposal!.id)?.status).toBe('resolved');
}, 180_000);

test('a host that may act on its own applies the change in the same turn', async () => {
  const f = await fixture('auto-approved', { autoApproved: true });

  const created = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: '把 Semantic Scholar MCP 加进资源库。', requestId: 'system-auto' }),
  });
  expect(created.status, JSON.stringify(created.body)).toBe(200);
  f.remember(created.body.conversationId);

  // The proposal says it was approved by the policy, and the change lands.
  await expect.poll(async () => existsSync(f.capabilityDirectory), { timeout: 60_000, interval: 250 }).toBe(true);
  const receipt = toolAnswers(f.provider.requests.filter(body => (body.tools ?? []).length).at(-1))
    .find(answer => answer && typeof answer === 'object' && 'proposalId' in answer && 'status' in answer) as any;
  expect(receipt, JSON.stringify(toolAnswers(f.provider.requests.at(-1)))).toBeTruthy();
  expect(receipt.status).toBe('auto_approved');
  const applied = toolAnswers(f.provider.requests.filter(body => (body.tools ?? []).length).at(-1))
    .find(answer => answer && typeof answer === 'object' && answer.applied === true) as any;
  expect(applied, JSON.stringify(toolAnswers(f.provider.requests.at(-1)))).toBeTruthy();
  expect(applied.result?.capability?.id).toBe('semantic-scholar');
  expect(applied.result?.capability?.status).toBe('available');
  expect(applied.proposalId).toBe(receipt.proposalId);
}, 180_000);

test('the health view is scoped to its own conversation', async () => {
  const f = await fixture('scope');

  const first = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: '看看这台机器怎么了。', requestId: 'scope-first' }),
  });
  expect(first.status, JSON.stringify(first.body)).toBe(200);
  const second = await f.request<{ conversationId: string }>('/api/conversations', {
    method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'local', text: '另一个会话。', requestId: 'scope-second' }),
  });
  expect(second.status, JSON.stringify(second.body)).toBe(200);
  f.remember(first.body.conversationId);

  // The health view the daemon answered with.
  await expect.poll(() => f.provider.requests.filter(body => (body.tools ?? []).length).length, { timeout: 60_000, interval: 250 })
    .toBeGreaterThan(0);
  const request = f.provider.requests.filter(body => (body.tools ?? []).length).at(-1);
  const health = toolAnswers(request).find(answer => answer && typeof answer === 'object' && 'scope' in answer) as any;
  expect(health, JSON.stringify(toolAnswers(request))).toBeTruthy();
  expect([first.body.conversationId, second.body.conversationId]).toContain(health.scope.conversationId);

  // The other conversation's task is not in this one's health view.
  const own = await f.view(first.body.conversationId);
  const other = await f.view(second.body.conversationId);
  const otherTask = health.scope.conversationId === first.body.conversationId ? other.anchorTaskId : own.anchorTaskId;
  expect(otherTask).toBeTruthy();
  expect(health.scope.taskIds).not.toContain(otherTask);
}, 180_000);
