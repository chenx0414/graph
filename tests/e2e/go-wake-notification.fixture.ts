import { execFileSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';

export interface ProviderTool { function?: { name?: string } }
export interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }
export interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }
export interface ProviderRequest {
  master: boolean;
  body: ProviderBody;
}

/** Real Git: the fixture project is a repository, so the daemon has a branch to work on. */
export function git(cwd: string, args: string[]) {
  execFileSync('git', args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Graph Test', GIT_AUTHOR_EMAIL: 'graph@example.invalid',
      GIT_COMMITTER_NAME: 'Graph Test', GIT_COMMITTER_EMAIL: 'graph@example.invalid',
      GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    },
  });
}

export const PROPOSAL = {
  requirementVersion: 1,
  summary: '通知链路',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '通知链路', protocols: { result: { type: 'object' } },
    nodes: Object.fromEntries(['work1', 'work2'].map(id => [id, { recipe: 'coder@1', model: 'local', task: 'Do the work.',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } }])),
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
      outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
    edges: { first: { from: 'work1.done', to: 'check.start', enabled: true },
      second: { from: 'work2.done', to: 'check.start', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
};

/** A provider that answers by role: main proposes, main dispatches, a worker submits. */
export async function wakeProvider() {
  const requests: ProviderRequest[] = [];
  // The master's next turn still carries the wake in its history, so the
  // dispatch happens once; a second graph_send would deliver the same input twice.
  let dispatched = false;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const master = (body.tools ?? []).some(tool => tool.function?.name === 'propose_graph');
    requests.push({ master, body });
    const lastUser = [...(body.messages ?? [])].reverse().find(message => message.role === 'user');
    if (master && JSON.stringify(lastUser?.content).includes('HOLD_SLOT_BEFORE_NODE_RESTART')) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(': occupied credential slot\n\n');
      return;
    }
    const wake = /Graph ([a-f0-9-]+) is ready and awaits explicit input/.exec(JSON.stringify(lastUser?.content ?? ''));
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
    if (master && !wake && !proposed) {
      response.write(toolCall('call-propose', 'propose_graph', { proposal: PROPOSAL, requestId: 'propose' }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (master && wake && !dispatched) {
      dispatched = true;
      const calls = ['work1', 'work2'].map((nodeId, index) => ({ index, id: `start-${nodeId}`, type: 'function',
        function: { name: 'graph_send', arguments: JSON.stringify({ graphId: wake[1], nodeId, input: 'job', value: { text: 'Run the work' } }) } }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: calls }, finish_reason: null }] }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    if (!master) {
      const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
      if (!submitted) {
        response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }));
        response.write(stop);
        response.end('data: [DONE]\n\n');
        return;
      }
    }
    // Every response reports usage: a turn without usage is a turn whose cost
    // nobody can prove, and the test must not depend on how that is treated.
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

