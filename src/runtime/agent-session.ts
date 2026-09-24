import type { StreamFn, ThinkingLevel } from '@earendil-works/pi-agent-core';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, ModelRuntime, RetrySettings, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SendGate } from './controlled-openai.ts';
import { openPiInstance } from './pi-instance.ts';
import { openPiProcess } from './pi-process.ts';
import { sdkPromptOptions } from './prompt-options.ts';

export interface AgentSessionBinding {
  instanceId: string;
  nodeId: string;
  definitionVersion: string;
}

export interface AgentSessionContext {
  mode: 'fresh' | 'fork' | 'rebind';
  sourceSessionId?: string;
  sourceSessionFile?: string;
  sourceLeafId?: string;
  sourceContextDigest?: string;
  reboundFromBundleDigest?: string;
  childContextDigest: string;
}

export interface AgentSessionInspect {
  binding: AgentSessionBinding;
  sessionId: string;
  sessionFile: string;
  model: string | undefined;
  messages: unknown[];
  leafId: string | null;
  bundleDigest: string | null;
  toolPolicyDigest: string | null;
  runtimePolicyDigest: string | null;
  piVersion: string | null;
  context?: AgentSessionContext;
  processId?: number;
  activeTools?: string[];
  registeredTools?: string[];
  loadedExtensions?: string[];
  loadedExtensionTools?: string[];
  extensionErrors?: { path: string; error: unknown }[];
}

export interface AgentSessionTurn {
  inspect: AgentSessionInspect;
  finalAssistantText: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface AgentSessionRequest {
  binding: AgentSessionBinding;
  workspace: string;
  stateDir: string;
  model: Model<Api>;
  stream: StreamFn;
  thinkingLevel?: ThinkingLevel;
  tools?: ToolDefinition[];
  nativeTools?: string[];
  skillPaths?: string[];
  readRoots?: string[];
  writeRoots?: string[];
  filesystemAccess?: 'bounded' | 'host';
  protectedPaths?: string[];
  allowGitMetadataWritesAll?: boolean;
  env?: Record<string, string>;
  networkDomains?: string[];
  allowUnrestrictedNetwork?: boolean;
  allowLocalBinding?: boolean;
  unixSockets?: string[];
  allowAllUnixSockets?: boolean;
  allowAppleEvents?: boolean;
  piExtensionPaths?: string[];
  piExtensionTools?: string[];
  systemPrompt?: string;
  allowedToolNames?: string[];
  bundleDigest: string;
  legacyCapabilityDigest?: string;
  toolPolicyDigest: string;
  runtimePolicyDigest: string;
  allowWorkspaceChange?: boolean;
  freshSession?: boolean;
  forkFrom?: { sessionFile: string; leafId?: string };
  readOnly?: boolean;
  compaction?: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
  retry?: RetrySettings;
  broker: SendGate;
  onEvent?: (event: AgentSessionEvent) => void;
}

export interface AgentSession {
  prompt(text: string, images?: ImageContent[]): Promise<AgentSessionTurn>;
  /** Prepare history before prompt; summary failure must not consume the turn.
   * A manual compaction may instead be followed directly by close(). */
  compact(customInstructions?: string): Promise<void>;
  steer(text: string): Promise<void>;
  /** Soft-stop the running turn: let the in-flight tool call finish, then end
   * the turn instead of issuing another model request. The session (and its
   * transcript) is retained so the same conversation can be prompted again.
   * Idempotent, including when no turn is running or the session is closed. */
  stop(): Promise<void>;
  inspect(): AgentSessionInspect;
  close(): Promise<void>;
}

export interface AgentSessionTransport {
  open(request: AgentSessionRequest): Promise<AgentSession>;
}

function assistantText(messages: unknown[]) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as { role?: string; content?: { type: string; text?: string }[] };
    if (message.role === 'assistant') {
      return message.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('') ?? '';
    }
  }
  return '';
}

function turn(inspect: AgentSessionInspect): AgentSessionTurn {
  const lastAssistant = [...inspect.messages].reverse().find(message => {
    return Boolean(message && typeof message === 'object' && !Array.isArray(message)
      && (message as { role?: unknown }).role === 'assistant');
  }) as { stopReason?: string; errorMessage?: string } | undefined;
  return {
    inspect,
    finalAssistantText: assistantText(inspect.messages),
    ...(lastAssistant?.stopReason ? { stopReason: lastAssistant.stopReason } : {}),
    ...(lastAssistant?.errorMessage ? { errorMessage: lastAssistant.errorMessage } : {}),
  };
}

function sessionState() {
  let closed = false;
  let promptStarted = false;
  let promptInFlight = false;
  return {
    beginPrompt() {
      if (closed) throw new Error('Agent session is closed');
      if (promptStarted || promptInFlight) throw new Error('Agent session already received a prompt');
      promptStarted = true;
      promptInFlight = true;
    },
    endPrompt() {
      promptInFlight = false;
    },
    beginSteer() {
      if (closed) throw new Error('Agent session is closed');
      if (!promptInFlight) throw new Error('Agent session is not accepting steering messages');
    },
    beginClose() {
      if (closed) return false;
      closed = true;
      return true;
    },
  };
}

export function createInProcessAgentSessionTransport(options: { modelRuntime: ModelRuntime }): AgentSessionTransport {
  return {
    async open(request) {
      const instance = await openPiInstance({
        binding: request.binding,
        workspace: request.workspace,
        stateDir: request.stateDir,
        model: request.model,
        modelRuntime: options.modelRuntime,
        stream: request.stream,
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
        ...(request.tools ? { tools: request.tools } : {}),
        ...(request.nativeTools?.length ? { nativeTools: request.nativeTools } : {}),
        ...(request.skillPaths?.length ? { skillPaths: request.skillPaths } : {}),
        ...(request.piExtensionPaths?.length ? { piExtensionPaths: request.piExtensionPaths } : {}),
        ...(request.piExtensionTools?.length ? { piExtensionTools: request.piExtensionTools } : {}),
        ...(request.systemPrompt ? { systemPrompt: request.systemPrompt } : {}),
        ...(request.allowedToolNames ? { allowedToolNames: request.allowedToolNames } : {}),
        hideSkillDescriptions: true,
        activateExtensionTools: true,
        bundleDigest: request.bundleDigest,
        ...(request.legacyCapabilityDigest ? { legacyCapabilityDigest: request.legacyCapabilityDigest } : {}),
        toolPolicyDigest: request.toolPolicyDigest,
        runtimePolicyDigest: request.runtimePolicyDigest,
        ...(request.allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
        ...(request.freshSession ? { freshSession: true } : {}),
        ...(request.forkFrom ? { forkFrom: request.forkFrom } : {}),
        ...(request.compaction ? { compaction: request.compaction } : {}),
        ...(request.retry ? { retry: request.retry } : {}),
        broker: request.broker,
        ...(request.onEvent ? { onEvent: request.onEvent } : {}),
      });
      const state = sessionState();
      return {
        async prompt(text, images) {
          state.beginPrompt();
          try {
            await instance.prompt(text, sdkPromptOptions(images));
            return turn(instance.inspect());
          } finally {
            state.endPrompt();
          }
        },
        async compact(customInstructions?: string) {
          await instance.compact(customInstructions);
        },
        async steer(text) {
          state.beginSteer();
          await instance.steer(text);
        },
        async stop() {
          await instance.stop();
        },
        inspect() {
          return instance.inspect();
        },
        async close() {
          if (!state.beginClose()) return;
          await instance.close();
        },
      };
    },
  };
}

export function createRestrictedProcessAgentSessionTransport(): AgentSessionTransport {
  return {
    async open(request) {
      const process = await openPiProcess(request);
      const state = sessionState();
      return {
        async prompt(text, images) {
          state.beginPrompt();
          try {
            const inspect = await process.prompt(text, images);
            return turn(inspect);
          } finally {
            state.endPrompt();
          }
        },
        async compact(customInstructions?: string) {
          await process.compact(customInstructions);
        },
        async steer(text) {
          state.beginSteer();
          await process.steer(text);
        },
        async stop() {
          await process.stop();
        },
        inspect() {
          return process.inspect();
        },
        async close() {
          if (!state.beginClose()) return;
          await process.close();
        },
      };
    },
  };
}
