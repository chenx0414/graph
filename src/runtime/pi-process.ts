import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Json } from '../core/types.ts';
import { nodeReadPaths } from './capabilities.ts';
import { graphNodeRuntime } from './workspace-command.ts';
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

export interface PiWorkerConfig {
  binding: { instanceId: string; nodeId: string; definitionVersion: string };
  workspace: string;
  stateDir: string;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
  tools: PiWorkerTool[];
  skillPaths: string[];
  piExtensionPaths: string[];
  piExtensionTools: string[];
  systemPrompt: string;
  appendSystemPrompt: string;
  capabilityDigest: string;
  allowWorkspaceChange?: boolean;
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
}

export interface PiWorkerInspect {
  binding: { instanceId: string; nodeId: string; definitionVersion: string };
  sessionId: string;
  sessionFile: string;
  model: string | undefined;
  messages: unknown[];
  leafId: string | null;
  capabilityDigest: string | null;
  processId: number;
}

interface PiWorkerResult {
  ok: boolean;
  inspect?: PiWorkerInspect;
  error?: string;
}

export interface PiProcessOptions {
  binding: { instanceId: string; nodeId: string; definitionVersion: string };
  workspace: string;
  stateDir: string;
  model: Model<Api>;
  stream: StreamFn;
  thinkingLevel?: ThinkingLevel;
  tools?: ToolDefinition[];
  skillPaths?: string[];
  piExtensionPaths?: string[];
  piExtensionTools?: string[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  capabilityDigest?: string;
  allowWorkspaceChange?: boolean;
  broker: SendGate;
  readOnly?: boolean;
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  onEvent?: (event: AgentSessionEvent) => void;
}

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

/** Run one AgentSession in an independent, OS-restricted Pi process.
 * The host keeps identity, credentials, gates and concrete tools; the child
 * receives only the exact capability bundle and proxy tool schemas. */
export async function openPiProcess(options: PiProcessOptions) {
  const workspace = await realpath(resolve(options.workspace));
  const requestedStateDir = resolve(options.stateDir);
  const scratchDir = join(requestedStateDir, 'process-scratch');
  await mkdir(scratchDir, { recursive: true, mode: 0o700 });
  const stateDir = await realpath(requestedStateDir);
  const canonicalScratch = await realpath(scratchDir);
  const configPath = join(stateDir, 'pi-worker.json');
  const workerPath = fileURLToPath(new URL('./pi-worker.ts', import.meta.url));
  const appRoot = await realpath(resolve(dirname(fileURLToPath(import.meta.url)), '../..'));
  const skillPaths = await Promise.all((options.skillPaths ?? []).map(path => realpath(path)));
  const piExtensionPaths = await Promise.all((options.piExtensionPaths ?? []).map(path => realpath(path)));
  const tools = options.tools ?? [];
  const config: PiWorkerConfig = {
    binding: options.binding,
    workspace,
    stateDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel ?? 'off',
    tools: serializedTools(tools),
    skillPaths,
    piExtensionPaths,
    piExtensionTools: options.piExtensionTools ?? [],
    systemPrompt: options.systemPrompt ?? `You are the ${options.binding.nodeId} Agent in Graph.`,
    appendSystemPrompt: options.appendSystemPrompt ?? '',
    capabilityDigest: options.capabilityDigest ?? '',
    ...(options.allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
    ...(options.compaction ? { compaction: options.compaction } : {}),
  };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

  const hostedTools = Object.fromEntries(tools.map(tool => [tool.name, gatedTool(tool, options.broker)]));
  const requests = createWorkerRequests({
    broker: options.broker,
    model: options.model,
    stream: options.stream,
    resources: {},
    tools: hostedTools,
    onEvent: event => options.onEvent?.(event as AgentSessionEvent),
  });
  const runtime = graphNodeRuntime();
  const acquired = await acquireRestrictedExecutor();
  const check = (options.broker as { check?: (reservation?: number) => void }).check;
  let control: { write(message: unknown): boolean; kill(): boolean } | undefined;
  let readyInspect: PiWorkerInspect | undefined;
  let finalInspect: PiWorkerInspect | undefined;
  let closed = false;
  let promptStarted = false;
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
      ...(await Promise.all(nodeReadPaths(runtime.execPath, runtime.electron).map(path => realpath(path)))),
    ],
    writePaths: [stateDir, ...(options.readOnly ? [] : [workspace])],
    ...(runtime.electron ? { env: { ELECTRON_RUN_AS_NODE: '1' } } : {}),
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
      return requests(request);
    },
  }).then(result => {
    if (result.code !== 0) {
      const message = result.stderr.trim() || `Pi process exited with code ${result.code ?? 'signal'}`;
      const error = new Error(message);
      if (!readyInspect) rejectReady(error);
      throw error;
    }
    finalInspect = parseInspect(result.stdout);
    return finalInspect;
  }).catch(error => {
    if (!readyInspect) rejectReady(error);
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
    async prompt(text: string) {
      if (promptStarted) throw new Error('Pi process already received a prompt');
      promptStarted = true;
      if (!control?.write({ operation: 'prompt', text })) throw new Error('Pi process input is closed');
      const inspect = await runPromise;
      finalInspect = inspect;
      return inspect;
    },
    async steer(text: string) {
      if (!control?.write({ operation: 'steer', text })) throw new Error('Pi process input is closed');
    },
    inspect() {
      return structuredClone(finalInspect ?? readyInspect!);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (!promptStarted) control?.write({ operation: 'close' });
      await runPromise.catch(() => undefined);
      await acquired.release();
    },
  };
}
