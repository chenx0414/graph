import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * What the main Agent is handed, and what it may ask about a draft.
 *
 * The main Agent does not start from a blank page: it is given an identity,
 * a compact set of rules and a documentation pointer, and it is told which
 * tools this session really has. The workflow prompt that used to sit in
 * there is gone, and so is the old draft shape - what remains is the small
 * set of rules that still bind.
 *
 * The draft surface is the other half: the Agent can ask whether a proposal
 * would be accepted *before* offering it, and the answer is an answer - a
 * refusal names the rule that refused it instead of failing the call. A
 * proposal that is offered then becomes a real draft the user can confirm.
 *
 * The proof is a real daemon, a real master Agent and a real provider: the
 * request that really left the process carries the rules, and the tool
 * results the model really read are the ones this test asserts on.
 */

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
interface ChatBody { tools?: { function?: { name?: string; description?: string } }[]; messages?: ChatMessage[] }

interface Step {
  id: string;
  name: string;
  args: unknown;
  before?: () => Promise<void>;
}

/**
 * A scripted model. It plays the plan in order and records what every tool
 * call answered, so the test reads the session the way the model read it.
 *
 * A request without tools is not the model speaking - it is the composer
 * asking for a suggested next message - and it is answered with plain text
 * so that it never eats a step of the plan.
 */
async function scriptedProvider(plan: () => Step[]) {
  const results = new Map<string, string>();
  const requests: ChatBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'The draft is as expected.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    await next.before?.();
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** The proposal the master offers: one node, one check, one acceptance item. */
const plan = {
  requirementVersion: 1,
  summary: 'Case-insensitive title search',
  acceptance: [{ id: 'ok', description: 'Works', checkNode: 'check' }],
  definition: {
    schemaVersion: 2,
    name: 'Title search',
    protocols: { result: { type: 'object' } },
    nodes: {
      work: {
        recipe: 'coder@1', model: 'worker', task: 'Implement case-insensitive title search',
        inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] },
      },
    },
    modules: {
      check: {
        type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } }, outputs: { result: { protocol: 'result' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['--version'], output: 'result' },
      },
    },
    edges: { checked: { from: 'work.done', to: 'check.start', enabled: true } },
    inputs: { job: { to: 'work.job', protocol: 'result' } },
    outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'ok', description: 'Works', kind: 'check', module: 'check' }],
  },
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-master-surface-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'README.md'), 'project\n');
  const configPath = join(root, 'graph.config.json');
  return { root, project, configPath };
}

const writeConfig = async (configPath: string, project: string, baseUrl: string) => {
  const credential = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'local' };
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    models: { entries: [
      { ...credential, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl, contextWindow: 32000 },
      { ...credential, id: 'worker', provider: 'graph-worker', modelId: 'worker-model', baseUrl, contextWindow: 32000 },
    ] },
  }));
};

test('the main Agent is given the compact rules, and none of the removed workflow prompt', async () => {
  const { root, project, configPath } = await fixture();
  const master = await scriptedProvider(() => []);
  await writeConfig(configPath, project, master.baseUrl);

  const daemon = await launchCli(root, { configPath, env: { GRAPH_LOCAL_KEY: 'local-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Implement title search.', requestId: 'master-rules' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.requests.length, { timeout: 120_000, interval: 250 }).toBeGreaterThan(0);

    const prompt = JSON.stringify(master.requests[0]);
    // The requirement the draft has to answer.
    expect(prompt).toContain('Requirement version: 1');
    // The rules section, with the shared rules first.
    expect(prompt).toContain('<rules>\\n- Use bash for file operations like ls, rg, find');
    // The rule that binds the main Agent.
    expect(prompt).toContain('R14 When one node stays blocked for three rounds');
    // The shape rule lives in the rules channel, which every turn receives - not
    // in a tool description, which has a byte budget and cannot carry it.
    expect(prompt).toContain('R15 Before you propose a graph, choose its shape');
    expect(prompt).toContain('shapeNotes in the propose receipt names the nodes');
    // The workflow prompt that was removed is really gone.
    expect(prompt).not.toContain('<workflow>');
    // And so is the old draft shape.
    expect(prompt).not.toContain('proposalJson schema');
  } finally {
    await daemon.close();
    await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

test('the main Agent can ask whether a proposal would be accepted, and its draft lands', async () => {
  const { root, project, configPath } = await fixture();
  const master = await scriptedProvider(() => [
    { id: 'state', name: 'get_graph_state', args: {} },
    { id: 'v-invalid', name: 'validate_proposal', args: { proposal: { ...plan, summary: '' } } },
    { id: 'v-valid', name: 'validate_proposal', args: { proposal: plan } },
    { id: 'obsolete', name: 'propose_graph', args: { proposalJson: JSON.stringify(plan), requestId: 'obsolete-plan' } },
    { id: 'p1', name: 'propose_graph', args: { proposal: plan, requestId: 'plan-1' } },
  ]);
  await writeConfig(configPath, project, master.baseUrl);

  const daemon = await launchCli(root, { configPath, env: { GRAPH_LOCAL_KEY: 'local-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Make a one node graph.', requestId: 'master-proposal' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('p1'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    // Before any draft there is no draft, and the conversation has only its master.
    const state = JSON.parse(master.results.get('state')!) as { taskId: string; proposalVersion: number; nodes: { id: string }[] };
    expect(state.proposalVersion).toBe(0);
    expect(state.nodes.map(node => node.id)).toEqual(['master']);

    // A proposal that would not be accepted is refused by name - as an answer,
    // not as a failed call.
    expect(JSON.parse(master.results.get('v-invalid')!)).toMatchObject({ valid: false, error: { code: 'invalid_proposal' } });
    // A proposal that would be accepted says so.
    expect(JSON.parse(master.results.get('v-valid')!)).toEqual({ valid: true, requirementVersion: 1 });

    // The old draft shape is refused, and it says what it expected.
    expect(master.results.get('obsolete')).toContain('proposal');

    // The draft really landed.
    const receipt = JSON.parse(master.results.get('p1')!) as { taskId: string; proposalVersion: number };
    expect(receipt.proposalVersion).toBe(1);
    const view = await (await daemon.request(`/api/tasks/${receipt.taskId}`)).json() as {
      proposalVersion: number;
      proposal: { summary: string; definition: { schemaVersion: number; nodes: Record<string, unknown> } };
    };
    expect(view.proposalVersion).toBe(1);
    expect(view.proposal.summary).toMatch(/title search/i);
    expect(view.proposal.definition.schemaVersion).toBe(2);
    expect(Object.keys(view.proposal.definition.nodes)).toEqual(['work']);

    // The tool the master was offered says what a proposal looks like.
    const tools = master.requests[0]?.tools ?? [];
    expect(tools.find(tool => tool.function?.name === 'propose_graph')?.function?.description).toContain('schemaVersion:2');
  } finally {
    await daemon.close();
    await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);

test('a draft that spends nodes without explaining them comes back with shape notes', async () => {
  const { root, project, configPath } = await fixture();
  // Two nodes that do the same job, one of them wired to nothing, and a summary
  // that never mentions either: every note the shape audit can raise, in one draft.
  const wasteful = {
    ...plan,
    summary: 'Case-insensitive title search',
    decisions: ['两个实现者并行改同一个函数'],
    definition: {
      ...plan.definition,
      nodes: {
        'work-a': plan.definition.nodes.work,
        'work-b': plan.definition.nodes.work,
      },
      edges: { checked: { from: 'work-a.done', to: 'check.start', enabled: true } },
      inputs: { job: { to: 'work-a.job', protocol: 'result' } },
      outputs: { result: { from: 'check.result', protocol: 'result' } },
    },
  };
  const master = await scriptedProvider(() => [
    { id: 'v-wasteful', name: 'validate_proposal', args: { proposal: wasteful } },
    { id: 'p-wasteful', name: 'propose_graph', args: { proposal: wasteful, requestId: 'plan-wasteful' } },
  ]);
  await writeConfig(configPath, project, master.baseUrl);
  const daemon = await launchCli(root, { configPath, env: { GRAPH_LOCAL_KEY: 'local-synthetic' }, extraArgs: ['--execute'] });
  try {
    const started = await daemon.request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Make a wasteful graph.', requestId: 'master-shape-notes' }),
    });
    expect(started.status).toBe(200);
    await expect.poll(() => master.results.has('p-wasteful'), { timeout: 180_000, interval: 250 }).toBeTruthy();

    const validation = JSON.parse(master.results.get('v-wasteful')!) as { valid: boolean; shapeNotes?: string[] };
    expect(validation.valid).toBe(true);
    const notes = (validation.shapeNotes ?? []).join('\n');
    // A node nobody explained.
    expect(notes).toContain('work-b 在 summary/decisions 里没有被提到');
    // Two nodes that are the same job.
    expect(notes).toContain('work-a、work-b 用同一个 recipe 与同样的 task');
    // A node wired to nothing.
    expect(notes).toContain('work-b 没有连到任何输入、输出或边');

    // The receipt carries the same notes, so nobody has to know to ask twice.
    const receipt = JSON.parse(master.results.get('p-wasteful')!) as { shapeNotes?: string[] };
    expect((receipt.shapeNotes ?? []).join('\n')).toContain('work-b 在 summary/decisions 里没有被提到');
  } finally {
    await daemon.close();
    await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240_000);
