import { spawnSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';

import { launchCli } from '../helpers/cli-daemon.ts';

/**
 * The fixtures of the module-operation budget cases: the scripted master model,
 * the daemon it drives, the graph definitions the cases create, and the reads
 * they make of the daemon's own state.
 */

export const DATA = { protocol: 'data' };

export interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
export interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ChatBody { tools?: { function?: { name?: string } }[]; messages?: ChatMessage[] }
export interface Step { id: string; name: string; args: unknown; before?: () => Promise<void> }

/** One operation as `graph_inspect` really answers it. */
export interface OperationAnswer {
  id: string;
  module_id: string;
  state: string;
  error: string | null;
  result?: {
    outputs: {
      result: {
        passed: boolean;
        code: number | null;
        verdict?: string;
        timedOut?: boolean;
        timeoutMs?: number;
        waitMs?: number;
        elapsedMs: number;
        stdout: string;
        stderr: string;
        record: string;
        outputFiles?: { stdout: { path: string; bytes: number }; stderr: { path: string; bytes: number } };
      };
    };
  };
}

/** One scripted model: it plays the plan in order and records what every call answered. */
export async function scriptedProvider(plan: () => Step[], onResult?: (id: string, content: string) => void) {
  const results = new Map<string, string>();
  const failures: string[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
      onResult?.(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    const next = plan().find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Nothing left to do.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    try {
      await next.before?.();
    } catch (error) {
      // A step whose precondition never held ends the turn: the test reads the
      // reason instead of waiting for a plan that can no longer run.
      failures.push(error instanceof Error ? error.message : String(error));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Stopped.' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    results, failures,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/** A graph of one public command module, with the budget this case is about. */
export function commandGraph(name: string, script: string, timeoutMs?: number) {
  return {
    schemaVersion: 2,
    name,
    protocols: { data: { type: 'object' } },
    nodes: {},
    modules: {
      check: {
        type: 'operation', trigger: 'each',
        inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: {
          action: 'workspace.command', version: 1, command: 'node', sandbox: false, output: 'result',
          args: ['-e', script],
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
      },
    },
    edges: {}, inputs: {}, outputs: {},
  };
}

/** A graph of one sandboxed command module: the branch that runs inside the OS sandbox. */
export function sandboxedGraph(name: string, script: string, timeoutMs: number) {
  return {
    schemaVersion: 2,
    name,
    protocols: { data: { type: 'object' } },
    nodes: {},
    modules: {
      check: {
        type: 'operation', trigger: 'each',
        inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: {
          action: 'workspace.command', version: 1, command: 'node', sandbox: true, output: 'result',
          args: [script], timeoutMs,
        },
      },
    },
    edges: {}, inputs: {}, outputs: {},
  };
}

/** Rows one daemon really has in its own state database. */
export function rows<T>(root: string, query: string, ...params: (string | number)[]): T[] {
  const db = new DatabaseSync(join(root, 'state', 'tasks.sqlite'), { readOnly: true, timeout: 5000 });
  try {
    return db.prepare(query).all(...params) as unknown as T[];
  } finally {
    db.close();
  }
}

/** Polls a fact the product settles on its own, naming what it saw when it never settles. */
export async function waitFor(read: () => Promise<string> | string, timeout: number) {
  const deadline = Date.now() + timeout;
  let seen = '';
  while (Date.now() < deadline) {
    seen = await read();
    if (seen === '') return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`never settled: ${seen}`);
}

/**
 * Whether this host lets one OS sandbox start inside another.
 *
 * The sandboxed branch really runs `/usr/bin/sandbox-exec`, and a shell that is
 * already sandboxed (an Agent workspace) is refused by the kernel with
 * `sandbox_apply: Operation not permitted`. The case below needs a host that
 * allows it; where it does not, it says so and skips instead of pretending.
 */
export function nestedSandboxAllowed(): boolean {
  return spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { stdio: 'ignore' }).status === 0;
}

/** One spelling for a path, whichever side of /private it was written on. */
export function canonical(path: string): string {
  return path.replace(/^\/private/, '');
}

/** A path the daemon reported, readable from this process. */
export function readable(path: string): string {
  return path.startsWith('/private/') ? path.replace(/^\/private/, '') : path;
}

/** One daemon, one project directory, and the master model that drives it. */
export async function harness(root: string, plan: () => Step[], onResult?: (id: string, content: string) => void) {
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const master = await scriptedProvider(plan, onResult);
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { budget: { secretRef: 'GRAPH_BUDGET_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
      baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'budget' }] },
  }));
  const daemon = await launchCli(root, { configPath, env: { GRAPH_BUDGET_KEY: 'budget-synthetic' }, extraArgs: ['--execute'] });
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };
  const started = await request('/api/conversations', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Run the check.', requestId: `budget-${root}` }),
  });
  return { master, daemon, request, started, close: async () => { await daemon.close(); await master.close(); } };
}
