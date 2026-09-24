import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Json } from '../core/types.ts';
import type {
  AgentSessionBinding, AgentSessionInspect, AgentSessionRequest,
} from './agent-session.ts';
import { nodeReadPaths } from './capabilities.ts';
import { graphNodeRuntime } from './workspace-command.ts';
import { graphApplicationRoot } from './graph-root.ts';
import { isExternallyGated } from './pi-instance.ts';
import { acquireRestrictedExecutor } from './restricted-process.ts';
import type { SendGate } from './controlled-openai.ts';
import { createWorkerRequests } from './worker-requests.ts';

export interface PiWorkerTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: Json;
}

export type PiWorkerConfig = Omit<AgentSessionRequest, 'stream' | 'broker' | 'onEvent' | 'tools' | 'readOnly'> & {
  binding: AgentSessionBinding;
  thinkingLevel: ThinkingLevel;
  tools: PiWorkerTool[];
  nativeTools: string[];
  skillPaths: string[];
  piExtensionPaths: string[];
  piExtensionTools: string[];
  systemPrompt: string;
  appendSystemPrompt: string;
  allowedToolNames: string[];
};

export type PiWorkerInspect = AgentSessionInspect & { processId: number };

interface PiWorkerResult {
  ok: boolean;
  inspect?: PiWorkerInspect;
  error?: string;
}

export type PiProcessOptions = AgentSessionRequest;

function serializedTools(tools: readonly ToolDefinition[]): PiWorkerTool[] {
  return tools.map(tool => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
    ...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
    parameters: tool.parameters as unknown as Json,
  }));
}

function gatedTool(tool: ToolDefinition, gate: SendGate): ToolDefinition {
  if (isExternallyGated(tool)) return tool;
  return {
    ...tool,
    execute: async (...args: Parameters<ToolDefinition['execute']>) => {
      const id = randomUUID();
      const result = gate.dispatch(id, 0, () => tool.execute(...args));
      try { return await result; }
      finally { gate.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); }
    },
  };
}

function parseInspect(stdout: string): PiWorkerInspect {
  const line = stdout.trim().split('\n').find(value => value.trim().length > 0);
  if (!line) throw new Error('Pi worker returned no result');
  const result = JSON.parse(line) as PiWorkerResult;
  if (!result.ok || !result.inspect) throw new Error(result.error ?? 'Pi worker failed without a result');
  return result.inspect;
}

async function capabilityEntryRoot(entry: string) {
  let directory = dirname(entry);
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'capability.json'))) return realpath(directory);
    directory = dirname(directory);
  }
  return realpath(dirname(entry));
}

/** Run one AgentSession in an independent, OS-restricted Pi process.
 * The host keeps identity, credentials, gates and concrete tools; the child
 * receives only the exact capability bundle and proxy tool schemas. */
export async function openPiProcess(options: PiProcessOptions) {
  if (typeof options.bundleDigest !== 'string' || !options.bundleDigest.trim()) {
    throw new Error('A nonempty capability digest is required for a production Agent process');
  }
  if (typeof options.toolPolicyDigest !== 'string' || !options.toolPolicyDigest.trim()) {
    throw new Error('A nonempty tool policy digest is required for a production Agent process');
  }
  if (typeof options.runtimePolicyDigest !== 'string' || !options.runtimePolicyDigest.trim()) {
    throw new Error('A nonempty runtime policy digest is required for a production Agent process');
  }
  const workspace = await realpath(resolve(options.workspace));
  const requestedStateDir = resolve(options.stateDir);
  const scratchDir = join(requestedStateDir, 'process-scratch');
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(requestedStateDir);
  const canonicalScratch = await realpath(scratchDir);
  const configPath = join(stateDir, 'pi-worker.json');
  const workerPath = fileURLToPath(new URL('./pi-worker.ts', import.meta.url));
  const appRoot = await realpath(graphApplicationRoot());
  const skillPaths = await Promise.all((options.skillPaths ?? []).map(path => realpath(path)));
  const piExtensionPaths = await Promise.all((options.piExtensionPaths ?? []).map(path => realpath(path)));
  const capabilityReadRoots = await Promise.all((options.readRoots ?? []).map(path => realpath(path)));
  const capabilityWriteRoots = await Promise.all((options.writeRoots ?? []).map(path => realpath(path)));
  const unixSockets = await Promise.all((options.unixSockets ?? []).map(path => realpath(path)));
  const extensionReadRoots = await Promise.all(piExtensionPaths.map(capabilityEntryRoot));
  const protectedReadPathExceptions = [...new Set([...skillPaths, ...extensionReadRoots])];
  const forkSource = options.forkFrom ? await realpath(options.forkFrom.sessionFile) : undefined;
  const forkFrom = forkSource
    ? { sessionFile: forkSource, ...(options.forkFrom?.leafId ? { leafId: options.forkFrom.leafId } : {}) }
    : undefined;
  const tools = options.tools ?? [];
  const config: PiWorkerConfig = {
    binding: options.binding,
    workspace,
    stateDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? 'off',
    tools: serializedTools(tools),
    nativeTools: options.nativeTools ?? [],
    skillPaths,
    piExtensionPaths,
    piExtensionTools: options.piExtensionTools ?? [],
    systemPrompt: options.systemPrompt ?? `You are the ${options.binding.nodeId} Agent in Graph.`,
    appendSystemPrompt: options.appendSystemPrompt ?? '',
    allowedToolNames: [...(options.allowedToolNames ?? [
      ...tools.map(tool => tool.name),
      ...(options.piExtensionTools ?? []),
    ])].sort(),
    bundleDigest: options.bundleDigest.trim(),
    ...(options.legacyCapabilityDigest ? { legacyCapabilityDigest: options.legacyCapabilityDigest } : {}),
    toolPolicyDigest: options.toolPolicyDigest.trim(),
    runtimePolicyDigest: options.runtimePolicyDigest.trim(),
    ...(options.allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
    ...(options.filesystemAccess ? { filesystemAccess: options.filesystemAccess } : {}),
    ...(options.protectedPaths?.length ? { protectedPaths: options.protectedPaths } : {}),
    ...(options.allowGitMetadataWritesAll ? { allowGitMetadataWritesAll: true } : {}),
    ...(options.freshSession ? { freshSession: true } : {}),
    ...(forkFrom ? { forkFrom } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const hostedTools = Object.fromEntries(tools.map(tool => [tool.name, gatedTool(tool, options.broker)]));
  const requests = createWorkerRequests({
    broker: options.broker,
    model: options.model,
    stream: options.stream,
    resources: {},
    tools: hostedTools,
    allowedNativeTools: config.nativeTools,
    allowedExtensionTools: options.piExtensionTools ?? [],
    onEvent: event => options.onEvent?.(event as AgentSessionEvent),
  });
  const runtime = graphNodeRuntime();
  const helperEnv: Record<string, string> = {
    ...(options.env ?? {}),
    ...(runtime.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
  };
  if (options.env?.PATH !== undefined) {
    helperEnv.PATH = [...new Set([
      dirname(runtime.execPath),
      ...options.env.PATH.split(':').filter(Boolean),
      '/usr/bin',
      '/bin',
    ])].join(':');
  }
  const acquired = await acquireRestrictedExecutor();
  const check = (options.broker as { check?: (reservation?: number) => void }).check;
  let control: { write(message: unknown): boolean; kill(): boolean } | undefined;
  let readyInspect: PiWorkerInspect | undefined;
  let latestInspect: PiWorkerInspect | undefined;
  let closed = false;
  let promptStarted = false;
  let pendingCompaction: PromiseWithResolvers<PiWorkerInspect> | undefined;
  let resolveReady: (value: PiWorkerInspect) => void;
  let rejectReady: (error: unknown) => void;
  const ready = new Promise<PiWorkerInspect>((resolveReadyPromise, rejectReadyPromise) => {
    resolveReady = resolveReadyPromise;
    rejectReady = rejectReadyPromise;
  });
  const runPromise = acquired.executor.run({
    broker: options.broker,
    cwd: workspace,
    scratchDir: canonicalScratch,
    executable: runtime.execPath,
    args: [workerPath, configPath],
    readPaths: [
      appRoot,
      workspace,
      stateDir,
      ...skillPaths,
      ...piExtensionPaths,
      ...capabilityReadRoots,
      ...capabilityWriteRoots,
      ...unixSockets,
      ...extensionReadRoots,
      ...(forkSource ? [forkSource] : []),
      ...(await Promise.all(nodeReadPaths(runtime.execPath, runtime.electron).map(path => realpath(path)))),
    ],
    writePaths: [stateDir, ...capabilityWriteRoots, ...unixSockets, ...(options.readOnly ? [] : [workspace])],
    ...(options.filesystemAccess ? { filesystem: options.filesystemAccess } : {}),
    // Full access grants host filesystem and network, so the Agent process is the user's own
    // process; without this it still could not reach the window server, the pasteboard or a nested
    // sandbox, which broke clipboard tools, Electron and browser automation despite the policy.
    ...(options.filesystemAccess === 'host' ? { unsandboxed: true } : {}),
    ...(options.protectedPaths?.length ? { protectedPaths: options.protectedPaths } : {}),
    ...(options.filesystemAccess === 'host' ? { protectedPathExceptions: [stateDir] } : {}),
    ...(options.filesystemAccess === 'host' && protectedReadPathExceptions.length
      ? { protectedReadPathExceptions }
      : {}),
    ...(options.allowGitMetadataWritesAll ? { allowGitMetadataWritesAll: true } : {}),
    ...(Object.keys(helperEnv).length ? { env: helperEnv } : {}),
    ...(options.networkDomains?.length ? { networkDomains: options.networkDomains } : {}),
    ...(options.allowUnrestrictedNetwork ? { allowUnrestrictedNetwork: true } : {}),
    ...(options.allowLocalBinding ? { allowLocalBinding: true } : {}),
    ...(options.allowAllUnixSockets ? { allowAllUnixSockets: true } : {}),
    ...(options.allowAppleEvents ? { allowAppleEvents: true } : {}),
    ...(unixSockets.length ? { unixSockets } : {}),
    keepStdinOpen: true,
    ...(typeof check === 'function' ? { preflight: () => check.call(options.broker) } : {}),
    onSpawn: processControl => {
      control = {
        write: processControl.write,
        kill: () => processControl.kill(),
      };
    },
    onRequest: async request => {
      const value = request && typeof request === 'object' && !Array.isArray(request) ? request as Record<string, unknown> : {};
      if (value.operation === 'ready') {
        if (!readyInspect) {
          readyInspect = value.inspect as PiWorkerInspect;
          resolveReady(readyInspect);
        }
        return null;
      }
      if (value.operation === 'compaction_result') {
        if (!pendingCompaction) throw new Error('Unexpected Pi compaction result');
        const result = value.result as PiWorkerResult;
        if (result.inspect) latestInspect = result.inspect;
        if (result.ok && result.inspect) pendingCompaction.resolve(result.inspect);
        else pendingCompaction.reject(new Error(result.error ?? 'Pi compaction failed without a result'));
        return null;
      }
      return requests(request);
    },
  }).then(result => {
    if (result.code !== 0) {
      const message = result.stderr.trim() || `Pi process exited with code ${result.code ?? 'signal'}`;
      const error = new Error(message);
      if (!readyInspect) rejectReady(error);
      throw error;
    }
    latestInspect = parseInspect(result.stdout);
    pendingCompaction?.reject(new Error('Pi process exited during compaction'));
    return latestInspect;
  }).catch(error => {
    if (!readyInspect) rejectReady(error);
    pendingCompaction?.reject(error);
    throw error;
  });
  void runPromise.catch(() => {});
  try {
    readyInspect = await ready;
  } catch (error) {
    if (control) control.kill();
    await acquired.release();
    throw error;
  }

  return {
    async prompt(text: string, images?: ImageContent[]) {
      if (closed) throw new Error('Pi process is closed');
      if (pendingCompaction) throw new Error('Pi process is compacting');
      if (promptStarted) throw new Error('Pi process already received a prompt');
      promptStarted = true;
      if (!control?.write({ operation: 'prompt', text, ...(images?.length ? { images } : {}) })) throw new Error('Pi process input is closed');
      const inspect = await runPromise;
      latestInspect = inspect;
      return inspect;
    },
    async compact(customInstructions?: string) {
      if (closed) throw new Error('Pi process is closed');
      if (pendingCompaction) throw new Error('Pi process is compacting');
      if (promptStarted) throw new Error('Pi process already received a prompt');
      // Compaction prepares this operation's prompt; it must not consume the
      // one-shot prompt or wait for the worker to exit.
      pendingCompaction = Promise.withResolvers<PiWorkerInspect>();
      try {
        if (!control?.write({ operation: 'compact', keepAlive: true, ...(customInstructions ? { text: customInstructions } : {}) })) {
          throw new Error('Pi process input is closed');
        }
        return await pendingCompaction.promise;
      } finally {
        pendingCompaction = undefined;
      }
    },
    async steer(text: string) {
      if (!control?.write({ operation: 'steer', text })) throw new Error('Pi process input is closed');
    },
    /** Ask the worker to soft-stop its running turn. Idempotent: a closed or
     * idle process accepts the request without throwing. */
    async stop() {
      if (closed) return;
      control?.write({ operation: 'stop' });
    },
    inspect() {
      return structuredClone(latestInspect ?? readyInspect!);
    },
    async close() {
      if (closed) return;
      closed = true;
      await pendingCompaction?.promise.catch(() => undefined);
      if (!promptStarted) control?.write({ operation: 'close' });
      await runPromise.catch(() => undefined);
      await acquired.release();
    },
  };
}
