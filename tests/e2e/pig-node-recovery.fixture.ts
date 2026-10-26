import { DatabaseSync } from 'node:sqlite';

import { createServer, type Server } from 'node:http';

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { execFileSync } from 'node:child_process';

import { launchCli } from '../helpers/cli-daemon.ts';
export const git = (cwd: string, args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

export interface ProviderTool { function?: { name?: string } }

export interface ProviderMessage { role?: string; content?: unknown; tool_calls?: { function?: { name?: string } }[] }

export interface ProviderBody { tools?: ProviderTool[]; messages?: ProviderMessage[] }

export interface ProviderRequest { master: boolean; body: ProviderBody }

export const PROPOSAL = {
  requirementVersion: 1,
  summary: '节点恢复',
  acceptance: [{ id: 'works', description: '节点跑完', checkNode: 'check' }],
  definition: {
    schemaVersion: 2, name: '节点恢复', protocols: { result: { type: 'object' } },
    nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Do the work.',
      inputs: { job: { protocol: 'result' } }, outputs: { done: { protocol: 'result' } }, submission: { required: ['done'] } } },
    modules: { check: { type: 'operation', trigger: 'each', inputs: { start: { protocol: 'result' } },
      outputs: { result: { protocol: 'result' } },
      operation: { action: 'workspace.command', version: 1, command: 'node', args: ['test/check.js'], output: 'result' } } },
    edges: { first: { from: 'work.done', to: 'check.start', enabled: true } },
    inputs: {}, outputs: { result: { from: 'check.result', protocol: 'result' } },
    acceptance: [{ id: 'works', description: '节点跑完', kind: 'check', module: 'check' }],
  },
};

export interface LaneProvider {
  requests: ProviderRequest[];
  baseUrl: string;
  close: () => Promise<void>;
}

export async function laneProvider(options: { hold: 'master' | 'worker' | 'none' }): Promise<LaneProvider> {
  const requests: ProviderRequest[] = [];
  let proposed = false;
  let dispatched = false;
  let masterTurns = 0;
  let workerTurns = 0;
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body: ProviderBody = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderBody : {};
    const names = (body.tools ?? []).map(tool => tool.function?.name);
    const master = names.includes('propose_graph') || names.includes('graph_send');
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
      // The master keeps a request open: the credential slot stays taken, so
      // the node's own send waits for it.
      if (options.hold === 'master' && masterTurns >= 3) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Still working.' }, finish_reason: null }] }));
        return;
      }
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Dispatched.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    // The worker submits its output, then answers.
    const submitted = (body.messages ?? []).some(message => message.tool_calls?.some(call => call.function?.name === 'submit'));
    if (!submitted) {
      workerTurns += 1;
      // The worker keeps its request open: the turn is at the model when the
      // daemon dies.
      if (options.hold === 'worker' && workerTurns === 1) {
        response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Working on it.' }, finish_reason: null }] }));
        return;
      }
      response.write(toolCall('call-submit', 'submit', { outputs: { done: { enable: true, value: { text: 'Worker finished' } } } }));
      response.write(stop);
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Done.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 5 } }));
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

export function workerRequests(provider: LaneProvider): ProviderRequest[] {
  return provider.requests.filter(entry => !entry.master);
}
