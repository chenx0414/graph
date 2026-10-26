import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { execFileSync } from 'node:child_process';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { afterEach, beforeAll, expect, test } from 'vitest';

import { build } from 'vite';

import { chromium } from 'playwright';

import { launchCli } from '../helpers/cli-daemon.ts';
export const cleanup: (() => Promise<void> | void)[] = [];

export let webDir: string;



beforeAll(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'graph-app-shell-ux-web-'));
  await build({ configFile: join(process.cwd(), 'vite.config.ts'), logLevel: 'error', build: { outDir: webDir, emptyOutDir: true } });
}, 60_000);



afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

export async function temp(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `graph-app-shell-ux-${name}-`));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

export function git(cwd: string, args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

export async function gitProject(dir: string) {
  await writeFile(join(dir, 'check.js'), 'console.log("check passed");\n');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 'graph@example.invalid']);
  git(dir, ['config', 'user.name', 'Graph Test']);
  git(dir, ['add', '.']);
  git(dir, ['commit', '-q', '-m', 'init']);
  return dir;
}

export async function consoleServer(root: string, options: { projects?: { id: string; root: string }[]; models?: number; model?: string; execute?: boolean } = {}) {
  const configPath = join(root, 'graph.config.json');
  // Without a model behind it the daemon only serves the console. A test that
  // needs the main Agent to act points it at a real provider.
  const entries = Array.from({ length: options.models ?? 1 }, (_, index) => ({
    id: index === 0 ? 'local' : `model-${index + 1}`, provider: options.model ? 'graph-master' : 'stub', grade: 'medium', api: 'openai-completions',
    baseUrl: options.model ?? 'http://127.0.0.1:1/v1', contextWindow: 2048, maxTokens: 128, credentialId: 'local',
  }));
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: options.projects ?? [{ id: 'alpha', root }],
    credentials: { local: { secretRef: 'GRAPH_SYNTH_KEY' } },
    models: { entries },
  }, null, 2));
  const daemon = await launchCli(root, {
    configPath, stateDir: join(root, 'state'), graphHome: join(root, 'graph'), webDir,
    env: { HOME: root, GRAPH_SYNTH_KEY: 'synthetic-shell-key' },
    extraArgs: options.execute ? ['--execute'] : [],
  });
  cleanup.push(() => daemon.close());
  return daemon;
}

export interface ScriptedStep { id: string; name: string; args: unknown }

export interface ScriptedToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }

export interface ScriptedMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ScriptedToolCall[] }

export interface ScriptedBody { tools?: { function?: { name?: string } }[]; messages?: ScriptedMessage[] }

export async function scriptedProvider(plan: (body: ScriptedBody) => ScriptedStep[] | Promise<ScriptedStep[]>) {
  const results = new Map<string, string>();
  const requests: ScriptedBody[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ScriptedBody;
    requests.push(body);
    for (const message of body.messages ?? []) {
      if (message.role !== 'tool') continue;
      const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      results.set(message.tool_call_id ?? '', content);
    }
    const spoken = new Set((body.messages ?? []).flatMap(message => (message.tool_calls ?? []).map(call => call.id ?? '')));
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const next = (await plan(body)).find(call => !spoken.has(call.id));
    if (!next) {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: 'Noted.' }, finish_reason: 'stop' }],
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
    results,
    requests,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

export async function libraryPrompt(promptRoot: string, key: string) {
  const override = await readFile(join(promptRoot, key), 'utf8').catch(() => null);
  if (override !== null) return override.trimEnd();
  const fallback = await readFile(join(promptRoot, 'defaults', key), 'utf8').catch(() => '');
  return fallback.trimEnd();
}

export async function libraryDisabledTools(promptRoot: string) {
  const raw = await readFile(join(promptRoot, 'tools.json'), 'utf8').catch(() => '{}');
  const parsed = JSON.parse(raw) as { disabled?: string[] };
  return parsed.disabled ?? [];
}

export function workerProposal(summary: string, check = 'check', criterion = 'ok') {
  return {
    requirementVersion: 1,
    summary,
    acceptance: [{ id: criterion, description: '检查通过', checkNode: check }],
    definition: {
      schemaVersion: 2, name: summary, protocols: { data: { type: 'object' } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Implement the requested work', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } },
      modules: { [check]: { type: 'operation', trigger: 'each', inputs: { job: { protocol: 'data' } }, outputs: { result: { protocol: 'data' } },
        operation: { action: 'workspace.command', version: 1, command: 'node', args: ['check.js'], output: 'result' } } },
      edges: { checkWork: { from: 'work.result', to: `${check}.job`, enabled: true } },
      acceptance: [{ id: criterion, description: '检查通过', kind: 'check', module: check }],
    },
  };
}

export async function createConversation(server: Daemon, body: Record<string, unknown>) {
  const response = await server.request('/api/conversations', { method: 'POST', body: JSON.stringify(body) });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ conversationId: string; taskId: string }>;
}

export async function conversationView(server: Daemon, conversationId: string) {
  const response = await server.request(`/api/conversations/${conversationId}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<ConversationView>;
}

export interface Daemon {
  url: string;
  request(path: string, init?: RequestInit): Promise<Response>;
}

export interface ConversationView {
  conversationId: string;
  anchorTaskId: string;
  master?: { status?: string };
  messages: { role: string; kind?: string; text?: string; data?: unknown }[];
  proposal?: { version: number; summary: string } | null;
  proposalHistory: { version: number }[];
  archivedProposals: { version: number }[];
  accepted: { taskId: string }[];
}

export async function taskView(server: Daemon, taskId: string) {
  const response = await server.request(`/api/tasks/${taskId}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<{ operations: { id: string; state: string }[]; master?: { status?: string } }>;
}

export async function catalogView(server: Daemon) {
  const response = await server.request('/api/catalog');
  expect(response.status).toBe(200);
  return response.json() as Promise<{ agentCombinations: { id: string; description: string }[] }>;
}
