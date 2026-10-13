import { existsSync } from 'node:fs';
import { mkdir, realpath, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { AgentSessionRequest } from './agent-session.ts';
import { nodeReadPaths } from './capabilities.ts';
import { developerPath } from './developer-path.ts';
import { graphApplicationRoot } from './graph-root.ts';
import { acquireRestrictedExecutor, type RestrictedProcessControl } from './restricted-process.ts';
import { graphNodeRuntime } from './workspace-command.ts';

export interface DurablePluginContext {
  entries: unknown[];
  branch: unknown[];
  sessionId: string;
  leafId: string | null;
  model?: unknown;
  contextUsage?: unknown;
}

export interface DurablePlugins {
  setContext(snapshot: DurablePluginContext): Promise<void>;
  tools: ToolDefinition[];
  loadedExtensions: string[];
  discoveredSkillPaths: string[];
  extensionErrors: { path: string; error: unknown }[];
  beforePrompt(text: string, images?: ImageContent[]): Promise<{ systemPrompt?: string; messages: unknown[] }>;
  onEvent(event: { type: string; [key: string]: unknown }): Promise<void>;
  beforeTool(name: string, callId: string, args: unknown): Promise<{ block?: boolean; reason?: string } | null>;
  afterTool(name: string, callId: string, args: unknown, result: unknown): Promise<unknown>;
  close(): Promise<void>;
}

async function extensionRoot(entry: string) {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'capability.json'))) return realpath(directory);
    directory = dirname(directory);
  }
  return realpath(dirname(entry));
}

/** Import and invoke plugins only inside their frozen OS capability policy. */
export async function openDurablePlugins(request: AgentSessionRequest, options: { context?: DurablePluginContext } = {}): Promise<DurablePlugins> {
  if (!request.piExtensionPaths?.length) return { setContext: async () => {}, tools: [], loadedExtensions: [], discoveredSkillPaths: [], extensionErrors: [], beforePrompt: async () => ({ messages: [] }), onEvent: async () => {}, beforeTool: async () => null, afterTool: async (_name, _id, _args, result) => result, close: async () => {} };
  const scratch = join(request.stateDir, 'durable-plugin-scratch');
  await mkdir(scratch, { recursive: true, mode: 0o700 });
  const configPath = join(scratch, `${randomUUID()}.json`);
  const paths = await Promise.all(request.piExtensionPaths.map(path => realpath(path)));
  const extensions = await Promise.all(paths.map(extensionRoot));
  const runtime = graphNodeRuntime();
  const workspace = await realpath(request.workspace);
  await writeFile(configPath, JSON.stringify({ paths, workspace, systemPrompt: request.systemPrompt ?? '', model: request.model, thinkingLevel: request.thinkingLevel,
    context: options.context, allowedToolNames: request.piExtensionTools ?? [], servers: request.mcpAdapterServers ?? [] }), { mode: 0o600 });
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; update?: (value: unknown) => void }>();
  const started = Promise.withResolvers<RestrictedProcessControl>();
  const acquired = await acquireRestrictedExecutor();
  let control: RestrictedProcessControl | undefined;
  let closed = false;
  let failed: Error | undefined;
  const reads = [await graphApplicationRoot(), workspace, request.stateDir, ...extensions, ...request.readRoots ?? [], ...request.writeRoots ?? [], ...request.unixSockets ?? [], ...nodeReadPaths(runtime.execPath, runtime.electron)];
  const exited = acquired.executor.run({
    broker: { dispatch: (_id, _reservation, send) => send(), settle: () => {} },
    cwd: workspace, scratchDir: scratch, executable: runtime.execPath,
    args: [fileURLToPath(new URL('./durable-plugin-worker.mjs', import.meta.url)), configPath],
    readPaths: [...new Set([...reads, ...request.filesystemAccess === 'host' && request.readOnly ? ['/'] : []])], writePaths: [scratch, ...request.readOnly ? [] : [workspace, ...request.writeRoots ?? []]],
    ...(request.filesystemAccess === 'host' && !request.readOnly ? { filesystem: 'host', unsandboxed: true, protectedPathExceptions: [request.stateDir], protectedReadPathExceptions: extensions } : {}),
    protectedPaths: request.protectedPaths ?? [], denyWrite: request.readOnly ? [workspace] : [], allowGitMetadataWritesAll: request.allowGitMetadataWritesAll ?? false,
    env: { ...request.env, PATH: developerPath([dirname(runtime.execPath), request.env?.PATH ?? process.env.PATH ?? '', '/usr/bin', '/bin', '/usr/sbin', '/sbin'].join(':')), ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
    networkDomains: request.networkDomains ?? [], allowUnrestrictedNetwork: request.allowUnrestrictedNetwork ?? false, allowLocalBinding: request.allowLocalBinding ?? false,
    unixSockets: request.unixSockets ?? [], allowAllUnixSockets: request.allowAllUnixSockets ?? false, allowAppleEvents: request.allowAppleEvents ?? false,
    keepStdinOpen: true,
    onSpawn: value => { control = value; started.resolve(value); },
    onWorkerMessage: value => {
      if (!value || typeof value !== 'object') return;
      const message = value as { id?: string; update?: string; value?: unknown; result?: unknown; error?: string };
      if (message.update) { pending.get(message.update)?.update?.(message.value); return; }
      if (!message.id) return;
      const call = pending.get(message.id); if (!call) return;
      pending.delete(message.id);
      if (message.error) call.reject(new Error(message.error)); else call.resolve(message.result);
    },
  }).then(result => {
    const error = new Error(result.stderr.trim() || `Plugin helper exited (${result.code ?? 'signal'})`);
    failed = error;
    started.reject(error); for (const call of pending.values()) call.reject(error); pending.clear();
  }, error => { failed = error instanceof Error ? error : new Error(String(error)); started.reject(failed); for (const call of pending.values()) call.reject(failed); pending.clear(); }).finally(() => acquired.release());
  const call = async (method: string, parameters: Record<string, unknown> = {}, signal?: AbortSignal, update?: (value: unknown) => void) => {
    if (closed) throw new Error('Plugin helper is closed');
    const process = await started.promise;
    if (failed) throw failed;
    const id = randomUUID(); const result = Promise.withResolvers<unknown>();
    pending.set(id, { ...result, ...(update ? { update } : {}) });
    const cancel = () => process.write({ method: 'cancel', target: id });
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      if (!process.write({ id, method, ...parameters })) { pending.delete(id); throw new Error('Plugin helper input is closed'); }
      if (signal?.aborted) cancel();
      return await result.promise;
    } finally { signal?.removeEventListener('abort', cancel); }
  };
  const close = async () => {
    if (closed) return;
    try { await call('close'); } finally { closed = true; control?.end(); control?.kill('SIGTERM'); await exited; await rm(configPath, { force: true }); }
  };
  try {
    const report = await call('ready') as { tools: Omit<ToolDefinition, 'execute'>[]; loadedExtensions: string[]; discoveredSkillPaths: string[]; extensionErrors: { path: string; error: unknown }[] };
    return {
      ...report,
      setContext: async snapshot => { await call('setContext', { snapshot }); },
      tools: report.tools.map(tool => ({ ...tool, execute: async (callId, args, signal, update) => await call('call', { callId, name: tool.name, args }, signal, update ? value => update(value as Parameters<typeof update>[0]) : undefined) as Awaited<ReturnType<ToolDefinition['execute']>> })),
      beforePrompt: async (text, images) => await call('beforePrompt', { text, images, systemPrompt: request.systemPrompt ?? '' }) as { systemPrompt?: string; messages: unknown[] },
      onEvent: async event => { await call('event', { event }); }, close,
      beforeTool: async (name, callId, args) => await call('beforeTool', { name, callId, args }) as { block?: boolean; reason?: string } | null,
      afterTool: async (name, callId, args, result) => await call('afterTool', { name, callId, args, result }),
    };
  } catch (error) { closed = true; control?.end(); control?.kill('SIGTERM'); await exited; await rm(configPath, { force: true }); throw error; }
}
