import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Api, Model } from '@earendil-works/pi-ai';
import type { ThinkingLevel } from '@earendil-works/pi-agent-core';
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  buildSessionContext,
  type ModelRuntime, type ToolDefinition, type AgentSessionEvent, type InlineExtension, type PromptOptions, type RetrySettings,
} from '@earendil-works/pi-coding-agent';
import { canonicalJson } from '../core/store.ts';
import type { SendGate } from './controlled-openai.ts';

export interface InstanceBinding {
  instanceId: string;
  nodeId: string;
  definitionVersion: string;
}

const EXTERNALLY_GATED = Symbol.for('graph.externally-gated');
const require = createRequire(import.meta.url);

const PI_PACKAGE_VERSION = (() => {
  try {
    const entry = require.resolve('@earendil-works/pi-coding-agent');
    const manifest = JSON.parse(readFileSync(join(dirname(entry), '..', 'package.json'), 'utf8')) as { version?: string };
    return manifest.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
})();
const SESSION_CLOSE_TIMEOUT_MS = 5_000;
const DEFAULT_RETRY_SETTINGS: RetrySettings = {
  enabled: true,
  maxRetries: 3,
  baseDelayMs: 500,
  // The Graph broker owns provider-send retries. Pi retries the assistant
  // turn here after a transient stream error without bypassing the gate.
  provider: { maxRetries: 0 },
};

/** Mark a tool whose execute already passes the send gate at its own effect boundary. */
export function externallyGated<T extends ToolDefinition>(tool: T): T {
  return Object.assign(tool, { [EXTERNALLY_GATED]: true });
}

export function isExternallyGated(tool: ToolDefinition) {
  return Boolean((tool as { [EXTERNALLY_GATED]?: boolean })[EXTERNALLY_GATED]);
}

export interface PiInstanceOptions {
  binding: InstanceBinding;
  workspace: string;
  stateDir: string;
  model: Model<Api>;
  modelRuntime: ModelRuntime;
  stream: StreamFn;
  thinkingLevel?: ThinkingLevel;
  tools?: ToolDefinition[];
  nativeTools?: string[];
  skillPaths?: string[];
  piExtensionPaths?: string[];
  piExtensionTools?: string[];
  extensionFactories?: InlineExtension[];
  systemPrompt?: string;
  appendSystemPrompt?: string;
  hideSkillDescriptions?: boolean;
  activateExtensionTools?: boolean;
  allowedToolNames?: string[];
  bundleDigest?: string;
  legacyCapabilityDigest?: string;
  toolPolicyDigest?: string;
  runtimePolicyDigest?: string;
  broker?: SendGate;
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  retry?: RetrySettings;
  /** A conversation master may bind a project after its first turn; the
   * session keeps its identity while the workspace moves to the project. */
  allowWorkspaceChange?: boolean;
  /** Create a new persistent session file from an immutable source leaf. */
  forkFrom?: {
    sessionFile: string;
    leafId?: string;
  };
  /** Start a new session for this instance instead of reopening its manifest. */
  freshSession?: boolean;
  onEvent?: (event: AgentSessionEvent) => void;
}

export interface SessionContextInfo {
  mode: 'fresh' | 'fork' | 'rebind';
  sourceSessionId?: string;
  sourceSessionFile?: string;
  sourceLeafId?: string;
  sourceContextDigest?: string;
  /** The bundle that owned the source session before a capability rebind. */
  reboundFromBundleDigest?: string;
  childContextDigest: string;
}

interface Manifest {
  version: 1 | 2 | 3;
  binding: InstanceBinding;
  workspace: string;
  sessionFile: string;
  sessionId: string;
  /** v2 compatibility field. New writes use bundleDigest. */
  capabilityDigest?: string;
  bundleDigest?: string;
  toolPolicyDigest?: string;
  runtimePolicyDigest?: string;
  model?: string;
  thinkingLevel?: string;
  activeTools?: string[];
  registeredTools?: string[];
  loadedExtensions?: string[];
  loadedExtensionTools?: string[];
  piVersion?: string;
  context?: SessionContextInfo;
}

const BUILTIN_TOOL_NAMES = new Set(['read', 'bash', 'edit', 'write', 'ls', 'find', 'grep', 'powershell']);

async function writeAtomic(path: string, value: string) {
  const pending = `${path}.pending`;
  await writeFile(pending, value, { mode: 0o600 });
  await rename(pending, path);
}

function contextDigest(context: ReturnType<typeof buildSessionContext>) {
  return createHash('sha256').update(canonicalJson(context as never)).digest('hex');
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
  if (manifest && ((manifest.version !== 1 && manifest.version !== 2 && manifest.version !== 3) ||
    (manifest.workspace !== workspace && !options.allowWorkspaceChange) ||
    manifest.binding.instanceId !== options.binding.instanceId ||
    manifest.binding.nodeId !== options.binding.nodeId ||
    manifest.binding.definitionVersion !== options.binding.definitionVersion)) {
    throw new Error('Instance binding does not match persisted identity');
  }
  const persistedDigest = manifest?.capabilityDigest?.trim();
  const persistedBundleDigest = manifest?.bundleDigest?.trim();
  const currentDigest = options.bundleDigest?.trim();
  let rebindFromManifest: Manifest | undefined;
  if (currentDigest && (!options.toolPolicyDigest?.trim() || !options.runtimePolicyDigest?.trim())) {
    throw new Error('Capability bundle digests require tool and runtime policy digests');
  }
  if ((manifest?.version ?? 0) >= 3) {
    if (!persistedBundleDigest) throw new Error('Persisted v3 capability bundle has no digest');
    if (!currentDigest) throw new Error('A capability bundle digest is required to restore this Agent session');
    if (persistedBundleDigest !== currentDigest) {
      rebindFromManifest = manifest;
    }
  } else if (manifest?.version === 2) {
    if (!persistedDigest) throw new Error('Persisted v2 capability bundle has no digest');
    if (!currentDigest) throw new Error('A capability bundle digest is required to restore this Agent session');
    if (!options.legacyCapabilityDigest) throw new Error('A legacy capability digest is required to restore this v2 Agent session');
    if (persistedDigest !== options.legacyCapabilityDigest) {
      // The same rule as v3: a legacy bundle change invalidates the bundle, not the conversation.
      rebindFromManifest = manifest;
    }
  } else if (manifest && currentDigest) {
    throw new Error('Legacy Agent session has no capability digest and cannot be rebound silently');
  }
  const sessionsDir = join(stateDir, 'sessions');
  const forceFresh = options.freshSession === true;
  if (manifest && !forceFresh) {
    const contents = await readFile(manifest.sessionFile, 'utf8'); // Missing is not new.
    const firstLine = contents.split('\n').find(line => line.trim().length > 0);
    const header = firstLine ? JSON.parse(firstLine) : undefined;
    if (!manifest.sessionId || header?.type !== 'session' || header.id !== manifest.sessionId) {
      throw new Error('Persisted session identity is missing or inconsistent');
    }
  }
  let manager: SessionManager;
  let contextInfo: SessionContextInfo | undefined = forceFresh || rebindFromManifest ? undefined : manifest?.context;
  if (manifest && !forceFresh && !rebindFromManifest) {
    manager = SessionManager.open(manifest.sessionFile, sessionsDir, workspace);
  } else if (rebindFromManifest) {
    // A capability update invalidates the old bundle but not the conversation.
    // Branch the persisted leaf into a new session file, then reopen it under
    // the new bundle; the old session stays immutable for audit.
    manager = SessionManager.open(rebindFromManifest.sessionFile, sessionsDir, workspace);
    const sourceLeafId = manager.getLeafId();
    if (!sourceLeafId) throw new Error('Cannot rebind a session without an active leaf');
    const entries = manager.getEntries();
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const sourceContext = buildSessionContext(entries, sourceLeafId, byId);
    const sourceSessionId = manager.getHeader()?.id;
    const sourceContextDigest = contextDigest(sourceContext);
    const branchedFile = manager.createBranchedSession(sourceLeafId);
    if (!branchedFile) throw new Error('Failed to create a rebased session file');
    const childContext = manager.buildSessionContext();
    const childContextDigest = contextDigest(childContext);
    if (sourceContextDigest !== childContextDigest) {
      throw new Error('Rebased session context digest mismatch');
    }
    const rebindSourceDigest = rebindFromManifest.bundleDigest ?? rebindFromManifest.capabilityDigest;
    contextInfo = {
      mode: 'rebind',
      ...(sourceSessionId ? { sourceSessionId } : {}),
      sourceSessionFile: rebindFromManifest.sessionFile,
      sourceLeafId,
      sourceContextDigest,
      ...(rebindSourceDigest ? { reboundFromBundleDigest: rebindSourceDigest } : {}),
      childContextDigest,
    };
  } else if (options.forkFrom) {
    const sourceFile = resolve(options.forkFrom.sessionFile);
    manager = SessionManager.open(sourceFile, sessionsDir, workspace);
    const sourceLeafId = options.forkFrom.leafId ?? manager.getLeafId();
    if (!sourceLeafId) throw new Error('Cannot fork a session without an active leaf');
    const entries = manager.getEntries();
    const byId = new Map(entries.map(entry => [entry.id, entry]));
    const sourceContext = buildSessionContext(entries, sourceLeafId, byId);
    const sourceSessionId = manager.getHeader()?.id;
    const sourceContextDigest = contextDigest(sourceContext);
    const branchedFile = manager.createBranchedSession(sourceLeafId);
    if (!branchedFile) throw new Error('Failed to create a forked session file');
    const childContext = manager.buildSessionContext();
    const childContextDigest = contextDigest(childContext);
    if (sourceContextDigest !== childContextDigest) {
      throw new Error('Forked session context digest mismatch');
    }
    contextInfo = {
      mode: 'fork',
      ...(sourceSessionId ? { sourceSessionId } : {}),
      sourceSessionFile: sourceFile,
      sourceLeafId,
      sourceContextDigest,
      childContextDigest,
    };
  } else {
    manager = SessionManager.create(workspace, sessionsDir);
  }
  const sessionFile = manager.getSessionFile();
  if (!sessionFile) throw new Error('Expected a persistent Pi session');
  if (manifest && !forceFresh && !rebindFromManifest && manager.getSessionId() !== manifest.sessionId) throw new Error('Persisted session identity changed');
  if (!options.forkFrom && !rebindFromManifest && (!manifest || forceFresh)) {
    // Bootstrap the public JSONL header, then reopen it through Pi's public API.
    // Pi now owns all subsequent appends, including the first user message.
    await writeAtomic(sessionFile, JSON.stringify(manager.getHeader()) + '\n');
    manager.setSessionFile(sessionFile);
  }
  if (!contextInfo) {
    contextInfo = { mode: 'fresh', childContextDigest: contextDigest(manager.buildSessionContext()) };
  }
  const retry = {
    ...DEFAULT_RETRY_SETTINGS,
    ...options.retry,
    provider: { ...DEFAULT_RETRY_SETTINGS.provider, ...options.retry?.provider },
  };
  const settings = SettingsManager.inMemory({
    compaction: options.compaction ?? { enabled: false }, retry,
    images: { autoResize: false },
    enableAnalytics: false, enableInstallTelemetry: false,
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace, agentDir: stateDir, settingsManager: settings,
    ...(options.skillPaths?.length ? { additionalSkillPaths: options.skillPaths } : {}),
    ...(options.piExtensionPaths?.length ? { additionalExtensionPaths: options.piExtensionPaths } : {}),
    ...(options.extensionFactories?.length ? { extensionFactories: options.extensionFactories } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.appendSystemPrompt ? { appendSystemPrompt: [options.appendSystemPrompt] } : {}),
    ...(options.hideSkillDescriptions ? {
      skillsOverride: base => ({
        ...base,
        skills: base.skills.map(skill => ({ ...skill, disableModelInvocation: true })),
      }),
    } : {}),
    noExtensions: true, noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true,
  });
  await loader.reload();
  if (options.tools?.some(tool => !isExternallyGated(tool)) && !options.broker) throw new Error('Tools require a call broker');
  const nativeTools = [...new Set((options.nativeTools ?? []).map(name => name.trim()).filter(Boolean))];
  const nativeToolNames = new Set(nativeTools);
  const customTools = options.tools?.filter(tool => !nativeToolNames.has(tool.name)).map(tool => isExternallyGated(tool) ? tool : {
    ...tool,
    execute: async (...args: Parameters<ToolDefinition['execute']>) => {
      const id = randomUUID();
      const result = options.broker!.dispatch(id, 0, () => tool.execute(...args));
      try { return await result; }
      finally { options.broker!.settle(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }); }
    },
  }) ?? [];
  const allowedToolNames = new Set([
    ...(options.allowedToolNames ?? [...customTools.map(tool => tool.name), ...options.piExtensionTools ?? []]),
    ...nativeTools,
  ]);
  const registeredToolNames = [
    ...customTools.map(tool => tool.name),
    ...nativeTools,
    ...loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]),
  ];
  const { session } = await createAgentSession({
    cwd: workspace, agentDir: stateDir, model: options.model,
    modelRuntime: options.modelRuntime, resourceLoader: loader,
    sessionManager: manager, settingsManager: settings, thinkingLevel: options.thinkingLevel ?? 'off',
    customTools,
    noTools: 'all',
    tools: [...allowedToolNames],
  });
  const customNames = new Set(customTools.map(tool => tool.name));
  const allowedExtensionTools = new Set(options.piExtensionTools ?? []);
  const extensionNames = options.activateExtensionTools
    ? loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()])
      .filter(name => !customNames.has(name) && !BUILTIN_TOOL_NAMES.has(name) && allowedExtensionTools.has(name))
    : [];
  const activeToolNames = session.getActiveToolNames().filter(name => customNames.has(name) || nativeToolNames.has(name) || extensionNames.includes(name));
  session.agent.streamFunction = options.stream;
  // Graph's terminal tool result ends this operation even in a mixed batch.
  // Let Pi persist all results, then stop before another model request.
  let stopRequested = false;
  const beforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => stopRequested
    ? { block: true, terminate: true, reason: 'The operation has completed; continue after the pending reload.' }
    : beforeToolCall?.(context, signal);
  session.agent.subscribe(event => {
    if (event.type === 'tool_execution_end' && event.result.terminate === true) stopRequested = true;
  });
  const shouldStopAfterTurn = session.agent.shouldStopAfterTurn;
  session.agent.shouldStopAfterTurn = (context, signal) => stopRequested || (shouldStopAfterTurn?.(context, signal) ?? false);
  if (options.onEvent) session.subscribe(options.onEvent);
  const loadedExtensions = loader.getExtensions().extensions.map(extension => extension.path);
  const loadedExtensionTools = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
  const piVersion = PI_PACKAGE_VERSION;
  await writeAtomic(manifestPath, JSON.stringify({
    version: currentDigest ? 3 : 1, binding: options.binding, workspace, sessionFile, sessionId: manager.getSessionId(),
    ...(currentDigest ? {
      bundleDigest: currentDigest,
      ...(options.toolPolicyDigest ? { toolPolicyDigest: options.toolPolicyDigest } : {}),
      ...(options.runtimePolicyDigest ? { runtimePolicyDigest: options.runtimePolicyDigest } : {}),
      model: options.model.id,
      thinkingLevel: options.thinkingLevel ?? 'off',
      activeTools: activeToolNames,
      registeredTools: [...new Set(registeredToolNames)],
      loadedExtensions,
      loadedExtensionTools,
      piVersion,
    } : {}),
    context: contextInfo,
  } satisfies Manifest));

  return {
    async prompt(text: string, options?: PromptOptions) {
      stopRequested = false;
      await session.prompt(text, options);
    },
    async steer(text: string) {
      await session.prompt(text, { streamingBehavior: 'steer', expandPromptTemplates: false });
    },
    async setModel(model: Model<Api>) { await session.setModel(model); },
    async compact(customInstructions?: string) { return session.compact(customInstructions); },
    async navigate(entryId: string, summarize: boolean) { return session.navigateTree(entryId, { summarize }); },
    inspect() {
      return {
        binding: structuredClone(options.binding), sessionId: manager.getSessionId(),
        sessionFile, model: session.model?.id, messages: structuredClone(session.messages), leafId: manager.getLeafId(),
        bundleDigest: options.bundleDigest ?? null,
        toolPolicyDigest: options.toolPolicyDigest ?? null,
        runtimePolicyDigest: options.runtimePolicyDigest ?? null,
        piVersion,
        context: structuredClone(contextInfo),
        activeTools: activeToolNames,
        registeredTools: [...new Set(registeredToolNames)],
        loadedExtensions,
        loadedExtensionTools,
        extensionErrors: loader.getExtensions().errors.map(error => ({ path: error.path, error: error.error })),
      };
    },
    async close() {
      session.dispose();
      const idle = session.agent.waitForIdle().catch(() => undefined);
      await Promise.race([
        idle,
        new Promise<void>(resolve => {
          const timeout = setTimeout(resolve, SESSION_CLOSE_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    },
  };
}
