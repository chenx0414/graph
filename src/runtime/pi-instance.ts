import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ModelRuntime, type ToolDefinition, type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent';
import type { CallBroker } from './call-broker.ts';

export interface InstanceBinding {
  instanceId: string;
  nodeId: string;
  definitionVersion: string;
}

export interface PiInstanceOptions {
  binding: InstanceBinding;
  workspace: string;
  stateDir: string;
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  stream: StreamFn;
  tools?: ToolDefinition[];
  broker?: CallBroker;
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  onEvent?: (event: AgentSessionEvent) => void;
}

interface Manifest {
  version: 1;
  binding: InstanceBinding;
  workspace: string;
  sessionFile: string;
  sessionId: string;
}

async function writeAtomic(path: string, value: string) {
  const pending = `${path}.pending`;
  await writeFile(pending, value, { mode: 0o600 });
  await rename(pending, path);
}

export async function openPiInstance(options: PiInstanceOptions) {
  const workspace = resolve(options.workspace);
  const stateDir = resolve(options.stateDir);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const manifestPath = join(stateDir, 'instance.json');
  let manifest: Manifest | undefined;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Manifest;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (manifest && (manifest.version !== 1 || manifest.workspace !== workspace ||
    manifest.binding.instanceId !== options.binding.instanceId ||
    manifest.binding.nodeId !== options.binding.nodeId ||
    manifest.binding.definitionVersion !== options.binding.definitionVersion)) {
    throw new Error('Instance binding does not match persisted identity');
  }
  const sessionsDir = join(stateDir, 'sessions');
  if (manifest) {
    const contents = await readFile(manifest.sessionFile, 'utf8'); // Missing is not new.
    const firstLine = contents.split('\n').find(line => line.trim().length > 0);
    const header = firstLine ? JSON.parse(firstLine) : undefined;
    if (!manifest.sessionId || header?.type !== 'session' || header.id !== manifest.sessionId) {
      throw new Error('Persisted session identity is missing or inconsistent');
    }
  }
  const manager = manifest
    ? SessionManager.open(manifest.sessionFile, sessionsDir, workspace)
    : SessionManager.create(workspace, sessionsDir);
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error('Expected a persistent Pi session');
  if (manifest && manager.getSessionId() !== manifest.sessionId) throw new Error('Persisted session identity changed');
  if (!manifest) {
    // Bootstrap the public JSONL header, then reopen it through Pi's public API.
    // Pi now owns all subsequent appends, including the first user message.
    await writeAtomic(sessionFile, JSON.stringify(manager.getHeader()) + '\n');
    manager.setSessionFile(sessionFile);
  }
  const settings = SettingsManager.inMemory({
    compaction: options.compaction ?? { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } },
    enableAnalytics: false, enableInstallTelemetry: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace, agentDir: stateDir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  if (options.tools?.length && !options.broker) throw new Error('Tools require a call broker');
  const customTools = options.tools?.map(tool => ({
    ...tool,
    execute: async (...args: Parameters<ToolDefinition['execute']>) => {
      const id = randomUUID();
      const result = options.broker!.dispatch(id, 0, () => tool.execute(...args));
      try { return await result; }
      finally { options.broker!.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); }
    },
  })) ?? [];
  const { session } = await createAgentSession({
    cwd: workspace, agentDir: stateDir, model: options.model,
    modelRuntime: options.modelRuntime, resourceLoader: loader,
    sessionManager: manager, settingsManager: settings, noTools: 'all', thinkingLevel: 'off',
    tools: customTools.map(tool => tool.name), customTools,
  });
  session.agent.streamFunction = options.stream;
  if (options.onEvent) session.subscribe(options.onEvent);
  await writeAtomic(manifestPath, JSON.stringify({
    version: 1, binding: options.binding, workspace, sessionFile, sessionId: manager.getSessionId(),
  } satisfies Manifest));

  return {
    async prompt(text: string) { await session.prompt(text); },
    async setModel(model: Model<Api>) { await session.setModel(model); },
    async compact() { return session.compact(); },
    async navigate(entryId: string, summarize: boolean) { return session.navigateTree(entryId, { summarize }); },
    inspect() {
      return {
        binding: structuredClone(options.binding), sessionId: manager.getSessionId(),
        sessionFile, model: session.model?.id, messages: structuredClone(session.messages), leafId: manager.getLeafId(),
      };
    },
    async close() {
      session.dispose();
      await session.agent.waitForIdle();
    },
  };
}
