import type { ModelThinkingLevel as ThinkingLevel } from '@earendil-works/pi-ai';
import type { ControlledStream as StreamFn } from './controlled-openai.ts';
import type { Api, ImageContent, Model } from '@earendil-works/pi-ai';
import type { AgentSessionEvent, RetrySettings, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { SendGate } from './controlled-openai.ts';
import type { SubmissionRecord } from '@earendil-works/pi-durable';
import type { FrozenDurableExecution } from './durable-host.ts';
import type { ModelEntry } from '../catalog/models.ts';
import type { NodeSpec } from '../core/types.ts';
import type { ResolvedAccessPolicy } from '../core/access-policy.ts';
import type { CapabilityOperation } from './capability-bundle.ts';

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
  /**
   * What the assistant message for THIS turn reported.
   *
   * §9 metering needs it: without it a node's turns cost nothing and the budget can never
   * be charged. The provider reports a cumulative-per-message figure, so this is the last
   * assistant message's usage, not a delta.
   */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | undefined;
}

export interface AgentSessionRequest {
  executionConfiguration?: { model: ModelEntry; spec: NodeSpec; accessPolicy?: ResolvedAccessPolicy };
  /** Release resources reattached to an existing durable admission. */
  onRecoveryClose?: () => Promise<void>;
  /** Settle the original Graph operation from its existing durable receipt. */
  onRecoveryComplete?: (turn: AgentSessionTurn) => Promise<void>;
  frozenResourcePaths?: { source: string; target: string }[];
  nodeExecutionConfiguration?: { model: ModelEntry; role: 'worker' | 'reviewer'; revision: number; base: 'project' | 'worktree'; access: ResolvedAccessPolicy };
  capabilityDescriptor?: CapabilityOperation['descriptor'];
  credentialReference?: { modelId: string; provider: string; credentialId?: string };
  /** Stable admitted execution identity, used for durable input idempotency. */
  executionId?: string;
  /** Stable input identity within a Graph execution; retries/continuations differ. */
  inputRequestId?: string;
  binding: AgentSessionBinding;
  /** Reporting sink for executed tool calls; the in-process transport forwards it to the instance. */
  onToolCall?: (call: { tool: string; ms: number; isError: boolean; target: string | null }) => void;
  workspace: string;
  stateDir: string;
  model: Model<Api>;
  stream: StreamFn;
  thinkingLevel?: ThinkingLevel;
  tools?: ToolDefinition[];
  nativeTools?: string[];
  skillPaths?: string[];
  /** The Agent's own skills folder: the SDK loads skills from here. */
  skillFolder?: string;
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
  /** MCP servers the adapter registers for this session; dropping them leaves the gateway empty. */
  mcpAdapterServers?: { name: string; definition: unknown }[];
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
  /** Abort active model/tool work now. When text is present it becomes the next
   * prompt in the same session, keeping the interrupted operation alive. */
  interrupt(text?: string): Promise<void>;
  /** Soft-stop the running turn: let the in-flight tool call finish, then end
   * the turn instead of issuing another model request. The session (and its
   * transcript) is retained so the same conversation can be prompted again.
   * Idempotent, including when no turn is running or the session is closed. */
  stop(): Promise<void>;
  inspect(): AgentSessionInspect;
  close(): Promise<void>;
}

export interface AgentSessionTransport {
  bootstrapRecovery?(): Promise<void>;
  waitForRecovery?(): Promise<void>;
  /** Bootstrap all original callback bindings before enabling the shared scheduler. */
  registerRecoveryFactory?(factory: (snapshot: FrozenDurableExecution, receipt?: SubmissionRecord) => Promise<AgentSessionRequest | undefined>): () => void;
  /** An already admitted, provably unsent durable input retains its attempt. */
  recoverableInput?(identity: string, executionId: string): Promise<{ requestId: string; attempt: number } | undefined>;
  open(request: AgentSessionRequest): Promise<AgentSession>;
}

/**
 * Read a provider usage report defensively.
 *
 * The shape comes from the SDK, and a model may omit or rename fields; a usage figure that
 * cannot be read is absent rather than zero, because "unknown" and "free" must not look the
 * same to a budget.
 */
export function normalizeAssistantUsage(raw: Record<string, unknown>): AgentSessionTurn['usage'] {
  const number = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0);
  const input = number(raw.input ?? raw.inputTokens ?? raw.promptTokens);
  const output = number(raw.output ?? raw.outputTokens ?? raw.completionTokens);
  const cacheRead = number(raw.cacheRead ?? raw.cacheReadTokens ?? raw.cachedInputTokens);
  const cacheWrite = number(raw.cacheWrite ?? raw.cacheWriteTokens);
  const declared = number(raw.total ?? raw.totalTokens);
  return { input, output, cacheRead, cacheWrite, total: declared || input + output + cacheRead + cacheWrite };
}

/**
 * The usage the newest assistant message reported, if any.
 *
 * Exported so main and node transports can interpret metering from the same provider report, rather than inventing a second interpretation of the provider's report.
 */
export function lastTurnUsage(inspect: AgentSessionInspect): AgentSessionTurn['usage'] {
  const lastAssistant = [...inspect.messages].reverse().find(message =>
    Boolean(message && typeof message === 'object' && !Array.isArray(message)
      && (message as { role?: unknown }).role === 'assistant')) as
    { usage?: Record<string, unknown> } | undefined;
  return lastAssistant?.usage ? normalizeAssistantUsage(lastAssistant.usage) : undefined;
}
