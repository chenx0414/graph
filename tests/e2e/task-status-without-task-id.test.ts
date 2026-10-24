import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A status query that names no task asks about the caller's own task.
//
// The Go supervisor read the graph's owner before it checked whether a task
// id was given, so a query without one dereferenced a nil pointer. The tool
// table turns that panic into the tool error the model reads, and the model
// read a Go runtime message instead of an answer - even though the original
// implementation has always answered such a query with the caller's own
// task, and it guards its owner lookup with exactly that check.
//
// The proof is the real Go daemon and a real conversation: the model asks
// for the status of a task it did not name, and the answer must be a status
// projection of the task the model is serving.

interface ProviderMessage { role?: string; content?: string }
interface ProviderRequest { messages?: ProviderMessage[] }

/** A provider whose main session asks for a status and names no task. */
async function statusProvider() {
  const requests: ProviderRequest[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) as ProviderRequest : {};
    requests.push(body);
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    if (requests.length === 1) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'status', type: 'function',
        function: { name: 'get_task_status', arguments: '{}' } }] }, finish_reason: null }] }));
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Your task has no nodes yet.' }, finish_reason: 'stop' }],
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

test('the status query without a task id answers about the caller instead of crashing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-task-status-'));
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const provider = await statusProvider();
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root }],
      credentials: { local: { secretRef: 'GRAPH_TASK_STATUS_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-task-status', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_TASK_STATUS_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'What is the status of my task?', requestId: 'status-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);

    // The reply reaches the model on the turn after the tool call.
    await expect.poll(async () => provider.requests.flatMap(request => request.messages ?? [])
      .filter(message => message.role === 'tool').length, { timeout: 60000, interval: 250 }).toBeGreaterThan(0);

    const reply = provider.requests.flatMap(request => request.messages ?? [])
      .filter(message => message.role === 'tool').at(-1)!.content ?? '';
    expect(reply).not.toMatch(/nil pointer|invalid memory address|panic/i);
    const view = JSON.parse(reply) as { taskId?: string; phase?: string; nodes?: unknown[] };
    expect(typeof view.taskId).toBe('string');
    expect(view.taskId).not.toBe('');
    expect(Array.isArray(view.nodes)).toBe(true);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 180000);
