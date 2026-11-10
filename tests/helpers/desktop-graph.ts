import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { launchCli } from './cli-daemon.ts';
import { desktopBinary } from './agent-desktop.ts';

/**
 * A real Graph daemon whose master Agent uses the desktop tool, plus a provider
 * that plays a scripted plan of tool calls per conversation.
 *
 * Everything here is a real component: the daemon is the built graphd, the
 * provider speaks the OpenAI stream the products reads, and the tool runs the
 * installed agent-desktop CLI (through a recording binary, so the argv the
 * product chose is on disk). Two test files share it: one proves the tool's
 * contract, the other what this host can actually see of the desktop.
 */

export interface PlannedCall { id: string; args: Record<string, unknown> }
export interface Plan { marker: string; calls: PlannedCall[] }

interface ToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface ChatMessage { role?: string; content?: unknown; tool_call_id?: string; tool_calls?: ToolCall[] }
export interface ProviderTool { type?: string; name?: string; description?: string; function?: { name?: string; description?: string; parameters?: unknown } }
interface ChatBody { tools?: ProviderTool[]; messages?: ChatMessage[] }

export const toolName = (tool: ProviderTool) => tool.function?.name ?? tool.name ?? '';
export const toolDescription = (tool: ProviderTool) => tool.function?.description ?? tool.description ?? '';

/** The master Agent: it plays the plan whose marker is in the user's message. */
export async function desktopProvider(plans: Plan[]) {
  const results = new Map<string, string>();
  const served = new Map<string, string>();
  let tools: ProviderTool[] = [];
  const server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()) as ChatBody;
    let spoken = '';
    for (const message of body.messages ?? []) {
      if (message.role === 'tool') {
        const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
        const base = served.get(message.tool_call_id ?? '') ?? message.tool_call_id;
        if (base) results.set(base, content);
        continue;
      }
      if (message.role === 'user') {
        spoken = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      }
    }
    if ((body.tools ?? []).length) tools = body.tools ?? [];
    const frame = (payload: unknown) => `data: ${JSON.stringify(payload)}\n\n`;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const stop = (text: string) => {
      response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 5 } }));
      response.end('data: [DONE]\n\n');
    };
    // A request without tools is not the master speaking.
    if (!(body.tools ?? []).length) {
      stop('Noted.');
      return;
    }
    const plan = plans.find(candidate => spoken.includes(candidate.marker)) ?? plans[0]!;
    const answered = plan.calls.filter(call => results.has(call.id)).length;
    const next = plan.calls[answered];
    if (!next) {
      stop('Nothing left to call.');
      return;
    }
    served.set(next.id, next.id);
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: next.id, type: 'function',
      function: { name: 'desktop', arguments: JSON.stringify(next.args) } }] }, finish_reason: null }] }));
    response.write(frame({ id: 'r', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }));
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    results,
    get tools() { return tools; },
    baseUrl: `http://127.0.0.1:${port}/v1`,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}

/**
 * A recording desktop binary: it appends the argv it was handed and then
 * becomes the real CLI, so every envelope still comes from the real program.
 *
 * This is how "headless by default" becomes observable without moving a cursor:
 * the product's own choice of flags is on disk, and `--headed` cannot hide
 * behind a permission refusal.
 */
export async function recordingBinary(realBinary: string, logPath: string): Promise<string> {
  const scriptPath = join(logPath, '..', 'desktop-recording.sh');
  const script = [
    '#!/bin/sh',
    `printf '%s\\n' "$@" >> ${JSON.stringify(logPath)}`,
    `printf -- '---\\n' >> ${JSON.stringify(logPath)}`,
    `exec ${JSON.stringify(realBinary)} "$@"`,
    '',
  ].join('\n');
  await writeFile(scriptPath, script, { mode: 0o755 });
  return scriptPath;
}

/** Every argv the recording binary was handed, in order. */
export async function recordedInvocations(logPath: string): Promise<string[][]> {
  const text = await readFile(logPath, 'utf8').catch(() => '');
  return text.split('---\n').filter(block => block.trim() !== '').map(block => block.split('\n').filter(line => line !== ''));
}

/** The files under a directory whose bytes contain a needle, for "did this leak" questions. */
export async function filesMentioning(root: string, needle: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) {
        const bytes = await readFile(path).catch(() => Buffer.alloc(0));
        if (bytes.includes(Buffer.from(needle))) found.push(relative(root, path));
      }
    }
  };
  await walk(root);
  return found;
}

export const envelopeOf = (text: string): Record<string, any> => JSON.parse(text.trimEnd()) as Record<string, any>;

/**
 * The text of one tool result as the provider received it: either the JSON
 * content blocks the tool returned or, for a refusal, the plain failure text.
 */
export const textOf = (result: string): string => {
  try {
    const parsed = JSON.parse(result) as any;
    if (Array.isArray(parsed?.content)) return parsed.content.map((block: any) => String(block?.text ?? '')).join('');
    if (typeof parsed === 'string') return parsed;
    return result;
  } catch {
    return result;
  }
};

/** One daemon, one provider and the directories a desktop test owns. */
export async function launchDesktopGraph(input: {
  plans: Plan[];
  /** When set, the CLI's own state root carries it, so a leak is traceable. */
  sentinel?: string;
  /**
   * A capability library install to expose as `<graph home>/capabilities/agent-desktop`.
   * With it the daemon gets no `GRAPH_DESKTOP_BIN`, so the tool has to find the
   * CLI the way the app does on this machine.
   */
  capabilityInstall?: string;
}) {
  const work = await mkdtemp(join(tmpdir(), 'graph-e2e-desktop-'));
  const project = join(work, 'project');
  await mkdir(project, { recursive: true });
  await writeFile(join(project, 'README.md'), '# Desktop capability project\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: project });
  execFileSync('git', ['config', 'user.email', 'graph@example.invalid'], { cwd: project });
  execFileSync('git', ['config', 'user.name', 'Graph Test'], { cwd: project });
  execFileSync('git', ['add', '.'], { cwd: project });
  execFileSync('git', ['commit', '-q', '-m', 'initial'], { cwd: project });

  const binary = desktopBinary();
  const desktopHome = join(work, input.sentinel ? `agent-desktop-${input.sentinel}` : 'agent-desktop');
  await mkdir(desktopHome, { recursive: true, mode: 0o700 });
  const argvLog = join(work, 'desktop-argv.log');
  const tracePath = join(work, 'desktop-trace.jsonl');
  const recording = await recordingBinary(binary, argvLog);
  // A plan can name the trace file it expects without knowing the temp path:
  // `<tracePath>` is replaced before the first request is served.
  for (const plan of input.plans) {
    for (const call of plan.calls) {
      if (Array.isArray(call.args.args)) {
        call.args.args = call.args.args.map(value => (value === '<tracePath>' ? tracePath : value));
      }
    }
  }

  if (input.capabilityInstall) {
    const capabilities = join(work, 'graph-home', 'capabilities');
    await mkdir(capabilities, { recursive: true });
    await symlink(input.capabilityInstall, join(capabilities, 'agent-desktop'), 'dir');
  }
  const provider = await desktopProvider(input.plans);
  const configPath = join(work, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
    credentials: { desktop: { secretRef: 'GRAPH_DESKTOP_KEY' } },
    models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
      baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512, credentialId: 'desktop' }] },
  }));
  const daemon = await launchCli(work, {
    configPath,
    env: {
      GRAPH_DESKTOP_KEY: 'desktop-synthetic', AGENT_DESKTOP_HOME: desktopHome,
      // A capability-library test must not be handed the binary it is supposed
      // to find, so the hint is absent there and the recording probe elsewhere.
      ...(input.capabilityInstall ? {} : { GRAPH_DESKTOP_BIN: recording }),
    },
    extraArgs: ['--execute'],
  });
  const open = async (text: string): Promise<string> => {
    const response = await daemon.request('/api/conversations', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId: 'p', model: 'main', text, requestId: `open-${text.slice(0, 24).replace(/\W+/g, '-')}` }),
    });
    const body = await response.text();
    if (response.status !== 200) throw new Error(`the conversation did not open: ${body}`);
    return (JSON.parse(body) as { conversationId: string }).conversationId;
  };
  const answer = (id: string) => textOf(provider.results.get(id) ?? '');
  return {
    work, project, daemon, provider, binary, desktopHome, argvLog, tracePath, open, answer,
    async close() {
      await daemon.close();
      await provider.close();
      await rm(work, { recursive: true, force: true });
    },
  };
}
