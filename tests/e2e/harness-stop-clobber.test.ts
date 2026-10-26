import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { execFileSync } from 'node:child_process';
const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * A step that is being stopped does not report a verdict afterwards.
 *
 * The stop cancels the queued work and waits for the running executions to
 * settle. The step writes its own result in a second write - the execution
 * first, then the node - so a node could report "succeeded" after the task it
 * belongs to had already stopped: the stop button clobbered by the very step
 * it was stopping.
 */

interface ProviderTool { function?: { name?: string } }
interface ProviderBody { tools?: ProviderTool[]; messages?: { role?: string; content?: unknown }[] }

const PROPOSAL = {
  requirementVersion: 1,
  summary: '停止语义',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '停止语义', protocols: { result: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Do the work.',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
      outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
    edges: { first: { from: 'work.done', to: 'check.start', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
}

test('a node that is stopped does not report success afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-stop-clobber-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Stop semantics\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);

  // The worker's request is held until the test releases it: the node is
  // running while the graph is stopped.
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  const requests: { master: boolean; body: ProviderBody }[] = [];
  let proposed = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const names = (body.tools ?? []).map(tool => tool.function?.name ?? '');
    const master = names.includes('propose_graph') || names.includes('graph_send');
    requests.push({ master, body });
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    const toolCall = (id: string, name: string, args: unknown) => frame({
      id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id, type: 'function',
        function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }],
    });
    const stop = frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 } });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (master) {
      if (!proposed) {
        proposed = true;
        response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
      const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(body.messages ?? []));
      if (wake) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'start-work', type: 'function',
          function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId: 'work', input: 'job', value: { text: 'Run the work' } }) } }] }, finish_reason: null }] }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Dispatched.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    // The worker's turn waits for the test.
    await held;
    response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }));
    response.write(stop);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  const configPath = join(root, 'graph.config.json');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_STOP_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high',
        api: 'openai-completions', baseUrl: `http://127.0.0.1:${port}/v1`, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_STOP_KEY: 'synthetic-stop-key' }, extraArgs: ['--execute'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'stop-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 250 }).toBe('succeeded');
    const draft = (await request(`/api/conversations/${conversationId}`)).body as { proposal?: { version?: number; draftRevision?: number; targetBranch?: string } };
    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.proposal?.version ?? 1, draftRevision: draft.proposal?.draftRevision ?? 1,
      targetBranch: draft.proposal?.targetBranch ?? 'main', requestId: 'stop-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;

    // The node's turn is running.
    await expect.poll(() => requests.filter(entry => !entry.master).length, { timeout: 90000, interval: 250 }).toBeGreaterThan(0);

    // The user stops the graph, and only then does the step finish.
    const stopped = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'stop' });
    expect(stopped.status, JSON.stringify(stopped.body)).toBe(200);
    release?.();
    await new Promise(resolve => setTimeout(resolve, 4000));

    const view = (await request(`/api/tasks/${taskId}`)).body as { nodes?: { id: string; status: string }[]; phase?: string };
    const node = (view.nodes ?? []).find(entry => entry.id === 'work');
    // The node of a stopped graph reports the stop: it is not running, and it
    // has no verdict of its own to report.
    const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
    const lines = (Array.isArray(events.body) ? events.body : []).slice(-12)
      .map((event: { cursor?: number; type?: string; data?: unknown }) => `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 160)}`);
    expect(node?.status, `the stopped node reports ${node?.status} in phase ${view.phase}\n${lines.join('\n')}`).toBe('idle');
  } finally {
    await daemon?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
}, 300000);
