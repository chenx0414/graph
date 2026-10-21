import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

// A real Pi extension: the module a Pi extension package ships, loaded by Pi's
// own extension loader.
const extensionSource = `export default function (pi) {
  pi.registerTool({
    name: 'proof_tool',
    description: 'Return a fixed proof string.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'extension-proof' }] }),
  });
}
`;

interface ProviderTool { function?: { name?: string } }
interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }

// The graph node lane runs a node's turn on the PiG kernel.
//
// The node's recipe binds a Pi extension, and the kernel hosts none. The node
// must therefore fail with a reason that names the extension - a node that
// quietly ran without the tool it was bound is worse than a node that says it
// cannot run.
const PROPOSAL = {
  requirementVersion: 1,
  summary: '节点泳道',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '节点泳道', protocols: { result: { type: 'object' } },
    nodes: { work: { recipe: 'proofworker@1', model: 'local', task: 'Do the work.',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
      outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
    edges: { first: { from: 'work.done', to: 'check.start', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
};

/** A provider that proposes the graph and then dispatches the node's input. */
async function laneProvider() {
  const requests: ProviderRequest[] = [];
  let dispatched = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    requests.push({ master, body });
    const lastUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const toolCall = (id: string, name: string, args: unknown) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const proposed = requests.some(entry => entry.body.messages?.some(message =>
      message.tool_calls?.some(call => call.function?.name === 'propose_graph')));
    if (master && !proposed) {
      response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content ?? ''));
    if (master && wake && !dispatched) {
      dispatched = true;
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'start-work', type: 'function',
        function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId: 'work', input: 'job', value: { text: 'Run the work' } }) } }] }, finish_reason: null }] }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;
  return {
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

interface ProviderRequest { master: boolean; body: ProviderBody }

test('a graph node whose recipe binds a Pi extension fails with the reason, on the PiG kernel', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-extension-'));
  const project = join(root, 'project');
  const home = join(root, 'graph-home');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Node lane project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);

  // The capability the node's recipe binds: a real Pi extension on disk.
  const capabilityDirectory = join(home, 'capabilities', 'pi-extension', 'proof-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'index.mjs'), extensionSource);
  await writeFile(join(capabilityDirectory, 'capability.json'), JSON.stringify({
    id: 'proof', kind: 'pi-extension', version: '1.0.0', name: 'Proof extension',
    entry: './index.mjs',
    tools: [{ name: 'proof_tool', description: 'Return a fixed proof string.' }],
  }));
  // The recipe the node runs. It is its own definition, so compiling it never
  // disturbs the master.
  await writeFile(join(home, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'proofworker', name: 'Proof worker', description: 'A worker that binds a Pi extension.',
      recommendedGrade: 'medium', review: false, tags: [],
      resources: [{ resourceId: 'proof', version: '1.0.0', role: 'pi-extension', required: false }],
    }],
  }));

  const provider = await laneProvider();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_EXTENSION_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-node-extension', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_NODE_EXTENSION_KEY: 'synthetic-node-extension-key' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    // The node's recipe has to be a published definition before the graph
    // names it.
    const compiled = await request('/api/catalog/combinations/proofworker/compile', 'POST');
    expect(compiled.status, JSON.stringify(compiled.body)).toBe(200);

    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'node-extension-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    let draft: { version?: number; draftRevision?: number; targetBranch?: string } = {};
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const proposal = (view.body as { proposal?: { version?: number; draftRevision?: number; targetBranch?: string } }).proposal;
      draft = proposal ?? {};
      return Boolean(proposal);
    }, { timeout: 60000, interval: 250 }).toBe(true);
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 500 }).toBe('succeeded');

    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
      targetBranch: draft.targetBranch ?? 'main', requestId: 'node-extension-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The node's turn cannot be honored, and it says why.
    let nodeStatus = '';
    let failureReason = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
      const rows = (Array.isArray(events.body) ? events.body : []) as { type?: string; data?: { nodeId?: string; reason?: string } }[];
      const failed = rows.find(event => event.type === 'graph.node.failed' && event.data?.nodeId === 'work');
      if (failed) {
        failureReason = failed.data?.reason ?? '';
        break;
      }
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      nodeStatus = nodes.find(node => node.id === 'work')?.status ?? '';
      if (nodeStatus === 'failed' || nodeStatus === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    expect(failureReason, `the node never failed; its status was ${nodeStatus}`).not.toBe('');
    // The reason names the extension and the capability to unbind.
    expect(failureReason).toContain('Pi extension');
    expect(failureReason).toContain('proof@1.0.0');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 240000);
