import { DatabaseSync } from 'node:sqlite';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { git } from '../../src/git/git.ts';
import { launchCli } from '../helpers/cli-daemon.ts';

// A recovered turn must be sent again with the tool surface it was admitted
// with, not the one the capability files happen to declare now.
//
// The capability declares which of its extension's tools the session may see;
// the extension registers them. Both are read from disk when the turn starts.
// So a capability whose declaration changes between the admission and the
// recovery changes the tools the recovered turn is offered - and ADR 0033
// forbids re-sending an admitted input with the configuration of the moment.
//
// The proof is a real graph with a real Pi extension. The extension registers
// two tools; the capability declares one of them. The node's turn is admitted
// but never sent (the master holds the only credential), the daemon dies,
// and the capability's declaration is rewritten while it is down. The
// recovered turn must still be offered the tool it was admitted with.

const extensionSource = `export default function (pi) {
  pi.registerTool({
    name: 'proof_tool',
    description: 'Return a fixed proof string.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'extension-proof' }] }),
  });
  pi.registerTool({
    name: 'proof_tool_v2',
    description: 'Return a fixed proof string, the second one.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'extension-proof-v2' }] }),
  });
}
`;

interface ProviderTool { function?: { name?: string } }
interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }
interface ProviderRequest { master: boolean; body: ProviderBody }

const PROPOSAL = {
  requirementVersion: 1,
  summary: '节点扩展工具冻结',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '节点扩展工具冻结', protocols: { result: { type: 'object' } },
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

/** A provider that proposes the graph, dispatches the node, and holds the master. */
async function laneProvider() {
  const requests: ProviderRequest[] = [];
  let proposed = false;
  let dispatched = false;
  let masterTurns = 0;
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
    if (master) {
      masterTurns += 1;
      if (!proposed) {
        proposed = true;
        response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
      const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content ?? ''));
      if (wake && !dispatched) {
        dispatched = true;
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'start-work', type: 'function',
          function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId: 'work', input: 'job', value: { text: 'Run the work' } }) } }] }, finish_reason: null }] }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
      // The master keeps its request open: the credential slot stays taken, so
      // the node's own send waits for it.
      if (masterTurns >= 3) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Still working.' }, finish_reason: null }] }));
        return;
      }
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Dispatched.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    // The node's own turn.
    const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
    if (!submitted) {
      response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }));
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

/** toolNames are the tools one provider request offered. */
function toolNames(request: ProviderRequest): string[] {
  return (request.body.tools ?? []).map(tool => tool.function?.name ?? '').filter(name => name !== '');
}

test('a recovered node turn is offered the extension tools it was admitted with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-extension-frozen-'));
  const project = join(root, 'project');
  const home = join(root, 'graph-home');
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Frozen extension project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);

  // The capability the node's recipe binds: a real Pi extension on disk. It
  // registers two tools and declares one of them.
  const capabilityDirectory = join(home, 'capabilities', 'pi-extension', 'proof-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'index.mjs'), extensionSource);
  const capabilityFile = join(capabilityDirectory, 'capability.json');
  const declares = (name: string) => JSON.stringify({
    id: 'proof', kind: 'pi-extension', version: '1.0.0', name: 'Proof extension',
    entry: './index.mjs',
    tools: [{ name, description: 'Return a fixed proof string.' }],
  });
  await writeFile(capabilityFile, declares('proof_tool'));
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
    const database = join(root, 'state/tasks.sqlite');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_FROZEN_EXTENSION_KEY' } },
      // One credential slot: the master holds it while the worker waits, so
      // the worker's input is accepted by the kernel and never sent.
      limits: { credentials: { local: 1 } },
      models: { entries: [{ id: 'local', provider: 'graph-frozen-extension', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_FROZEN_EXTENSION_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };

    const compiled = await request('/api/catalog/combinations/proofworker/compile', 'POST');
    expect(compiled.status, JSON.stringify(compiled.body)).toBe(200);

    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'frozen-1',
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
      targetBranch: draft.targetBranch ?? 'main', requestId: 'frozen-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The node's input must be accepted by the kernel and never reach the model.
    const admitted = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const execution = db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id='work' ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
        if (!execution) return { execution: '', admitted: false, sent: false };
        const submission = db.prepare("SELECT COUNT(*) AS n FROM graph_durable_submissions WHERE json_extract(request_id,'$') LIKE ?").get(`%${execution.id}:attempt:%`) as { n: number };
        const call = db.prepare("SELECT COUNT(*) AS n FROM kernel_provider_calls WHERE execution_id=?").get(execution.id) as { n: number };
        return { execution: execution.id, admitted: submission.n > 0, sent: call.n > 0 };
      } finally { db.close(); }
    };
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !admitted().admitted) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(admitted().admitted, 'the node never admitted its input').toBe(true);
    expect(admitted().sent, 'the worker reached the model before the daemon died').toBe(false);

    // The capability changes while the daemon is down: the extension still
    // registers both tools, but the capability now declares the other one.
    daemon.child.kill('SIGKILL');
    await daemon.close();
    await writeFile(capabilityFile, declares('proof_tool_v2'));

    daemon = await start();
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

    // The recovered turn must be offered the tool it was admitted with.
    await expect.poll(() => provider.requests.filter(entry => !entry.master).length, { timeout: 90000, interval: 500 })
      .toBeGreaterThan(0);
    const workerRequests = provider.requests.filter(entry => !entry.master);
    const offered = toolNames(workerRequests[workerRequests.length - 1]!);
    expect(offered, `the recovered turn was offered ${JSON.stringify(offered)}`).toContain('proof_tool');
    expect(offered, `the recovered turn was offered ${JSON.stringify(offered)}`).not.toContain('proof_tool_v2');
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);
