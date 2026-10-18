import { workerModelOptions } from './worker-model-options.ts';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createAssistantMessageEventStream, type AssistantMessageFrame, type AssistantMessage, type ImageContent, type Model, type Api } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { openPiInstance } from './pi-instance.ts';
import { replayAssistantStream } from './assistant-stream-frames.ts';
import { controlledOpenAIStream } from './controlled-openai.ts';
import { sdkPromptOptions } from './prompt-options.ts';
import { lastTurnUsage, type AgentSessionInspect } from './agent-session.ts';
import type { PiWorkerConfig } from './pi-process.ts';

/**
 * Issue #1 §7 / §16 feasibility spike: a RESIDENT worker that survives across turns.
 *
 * The production `pi-worker.ts` runs exactly one prompt and then `process.exit(0)`:
 * `openPiProcess` marks the process spent after its first prompt. The new kernel
 * needs the opposite — one long-lived process per node that accepts
 * `start-turn` / `inspect` / `close` until the graph ends, keeping its session
 * lineage across turns and releasing its execution slot while idle (§7, §14).
 *
 * The spike drives the SAME underlying Pi session API (`openPiInstance().prompt()`)
 * the production worker uses, so residency is proven at the real SDK boundary.
 *
 * Channel layout (chosen for the spike, ready for the kernel host):
 *   - stdin       : host → worker control commands, one JSON object per line
 *                   (`start-turn`, `inspect`, `close`), each carrying `requestId`.
 *   - fd 3        : worker → host notifications, one JSON object per line
 *                   (`ready`, `turn_result`, `inspect_result`, `event`), echoing
 *                   the command's `requestId` so replies stay matched.
 *   - provider HTTP: the worker calls its registered provider through the SAME
 *                   production transport (`controlledOpenAIStream`). Measured
 *                   fact: registering a provider with only `apiKey` is NOT enough —
 *                   the native HTTP path reads the credential store and fails with
 *                   "No API key for provider" before any HTTP call, which is why the
 *                   one-shot worker overrides `stream` and why this one does too.
 */

/** Worker entry point for the resident mode. Started as its own OS process with a config file path. */
export async function runResidentWorker(configPath: string): Promise<void> {
  const config = JSON.parse(await readFile(configPath, 'utf8')) as PiWorkerConfig;
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  let closed = false;
  let ownerDisconnected = false;
  const outbox: unknown[] = [];
  let flushScheduled = false;
  const notify = (value: Record<string, unknown>) => {
    if (ownerDisconnected || channel.destroyed) return;
    outbox.push(value);
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      while (outbox.length && !channel.destroyed) {
        const item = outbox.shift();
        if (item !== undefined) channel.write(`${JSON.stringify(item)}\n`);
      }
    });
  };

  /**
   * The host side of a node's tool call (HB-262).
   *
   * The node runs here, but a tool like `submit` must execute in the host: §5 requires
   * the HOST to bind the executionId and the sender, and the model must not be able to
   * forge either. So the call travels out on this channel and the answer comes back on
   * stdin. Only tools the host actually offered are callable — an undeclared name never
   * becomes a tool the model can see in the first place.
   */
  const toolPending = new Map<string, (reply: { ok: boolean; text: string }) => void>();
  const callHost = (name: string, args: unknown): Promise<{ ok: boolean; text: string }> =>
    new Promise(resolve => {
      if (ownerDisconnected) { resolve({ ok: false, text: 'Resident owner disconnected' }); return; }
      const requestId = `tool-${randomUUID()}`;
      toolPending.set(requestId, resolve);
      notify({ operation: 'tool_call', requestId, name, args });
    });

  const modelPending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  let unknownUsage = false;
  const hostStream: import('@earendil-works/pi-agent-core').StreamFn = async (_model, context, options) => {
    if (ownerDisconnected) throw new Error('Resident owner disconnected');
    const requestId = `model-${randomUUID()}`;
    const reply = await new Promise<unknown>((resolve, reject) => {
      modelPending.set(requestId, { resolve, reject });
      notify({ operation: 'model_call', requestId, context, options: workerModelOptions(options) });
    }) as { frames: AssistantMessageFrame[]; settlement: AssistantMessage; usage?: typeof turnUsage };
    if (!reply.usage) unknownUsage = true;
    else for (const name of ['input', 'output', 'cacheRead', 'cacheWrite', 'total'] as const) turnUsage[name] += reply.usage[name];
    const output = createAssistantMessageEventStream();
    for (const event of replayAssistantStream(reply.frames, reply.settlement)) output.push(event);
    return output;
  };

  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({
    credentials, modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerProvider(config.model.provider, {
    api: config.model.api,
    baseUrl: config.model.baseUrl,
    apiKey: 'graph-host-broker-placeholder',
    models: [config.model],
  });
  // The spike drives the same production transport the one-shot worker uses, so
  // residency is proven end to end over real HTTP against the provider base URL.
  // The gate is permissive here: the spike tests residency, not admission control.
  const permissiveGate = {
    dispatch: <T>(_id: string, _reservation: number, send: () => T): T => send(),
    settle: (): void => undefined,
  };
  // The host owns the credential (§3): it writes the resolved transport into the config, so
  // the worker reaches the provider with the same key the host meters. Only when the config
  // carries none - a spike or a local test - does the worker fall back to a placeholder.
  const recording = { onSend: (prompt: { systemPrompt: string | null; toolDeclarations: string | null }) =>
    notify({ operation: 'event', event: { type: 'graph_provider_prompt', systemPrompt: prompt.systemPrompt ?? '', tools: prompt.toolDeclarations ?? '[]' } }) };
  const stream = config.hostModel ? hostStream : config.transport
    ? controlledOpenAIStream(permissiveGate, config.transport.apiKey, undefined, config.transport.api, recording)
    : controlledOpenAIStream(permissiveGate, 'spike-credential', undefined, 'openai-completions', recording);

  const session = await openPiInstance({
    binding: config.binding,
    workspace: config.workspace,
    ...(config.allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
    stateDir: config.stateDir,
    model: config.model as Model<Api>,
    modelRuntime,
    stream,
    thinkingLevel: config.thinkingLevel,
    ...(config.compaction ? { compaction: config.compaction } : {}),
    tools: forwardingTools(config, (name, args) => callHost(name, args)),
    nativeTools: config.nativeTools ?? [],
    beforeNativeTool: async call => {
      const result = await callHost('native_tool_start', call);
      if (!result.ok) throw new Error(result.text);
    },
    afterNativeTool: async call => {
      const result = await callHost('native_tool_settle', call);
      if (!result.ok) throw new Error(result.text);
    },
    skillPaths: config.skillPaths,
    ...(config.skillFolder ? { skillFolder: config.skillFolder } : {}),
    piExtensionPaths: config.piExtensionPaths,
    piExtensionTools: config.piExtensionTools,
    ...(config.mcpAdapterServers ? { mcpAdapterServers: config.mcpAdapterServers } : {}),
    // A forwarding tool makes no model call, so it reserves nothing from the send gate.
    // The gate exists to meter model traffic; the host meters whatever the call does.
    broker: { dispatch: <T>(_id: string, _reservation: number, send: () => T): T => send(), settle: (): void => undefined },
    systemPrompt: config.systemPrompt,
    // The host declares which tools this node may call; an empty list means the node
    // offered tools are exactly the ones the host named, so passing it through is what
    // makes them callable at all (HB-262).
    allowedToolNames: config.allowedToolNames ?? [],
    deferredCatalogTools: config.deferredCatalogTools ?? false,
    deferredBrowserTools: config.deferredBrowserTools ?? false,
    compactShellResults: config.compactShellResults ?? false,
    bundleDigest: config.bundleDigest,
    toolPolicyDigest: config.toolPolicyDigest,
    runtimePolicyDigest: config.runtimePolicyDigest,
    ...(config.freshSession ? { freshSession: true } : {}),
    onEvent: event => { notify({ operation: 'event', event }); },
  });
  const inspect = () => ({ ...session.inspect(), processId: process.pid }) as AgentSessionInspect & { processId: number };

  let running = false;
  notify({ operation: 'ready', inspect: inspect() });

  const controls = createInterface({ input: process.stdin });
  const commands = controls[Symbol.asyncIterator]();
  let interrupting: Promise<void> | undefined;
  const ownerLost = () => {
    closed = true;
    ownerDisconnected = true;
    outbox.length = 0;
    for (const pending of modelPending.values()) pending.reject(new Error('Resident owner disconnected'));
    modelPending.clear();
    for (const resolve of toolPending.values()) resolve({ ok: false, text: 'Resident owner disconnected' });
    toolPending.clear();
    interrupting ??= session.interrupt().catch(() => undefined);
  };
  controls.once('close', ownerLost);
  channel.on('error', () => controls.close());
  channel.on('end', () => controls.close());
  // The reader must stay responsive WHILE a turn runs: a tool the node calls is answered
  // by the host on this same stdin, so blocking the reader to await the turn would
  // deadlock — the turn waits for the tool result, and the tool result waits for the
  // reader (HB-262). Each command is therefore handled without holding the loop.
  const inFlight: Promise<void>[] = [];
  try {
    for await (const line of commands) {
      if (!line.trim()) continue;
      let command: Record<string, unknown>;
      try { command = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      const requestId = typeof command.requestId === 'string' ? command.requestId : undefined;
      const reply = (value: Record<string, unknown>) => notify({ ...value, ...(requestId ? { requestId } : {}) });
      // The host's answer to a tool call this node made (HB-262).
      if (command.operation === 'model_result' && requestId) {
        const pending = modelPending.get(requestId);
        if (pending) {
          modelPending.delete(requestId);
          if (command.ok === true) pending.resolve(command.value);
          else pending.reject(new Error(String(command.error ?? 'Host model request failed')));
        }
        continue;
      }
      if (command.operation === 'tool_result' && requestId) {
        const resolve = toolPending.get(requestId);
        if (resolve) {
          toolPending.delete(requestId);
          resolve({ ok: command.ok === true, text: String(command.text ?? '') });
        }
        continue;
      }
      if (command.operation === 'inspect') { reply({ operation: 'inspect_result', inspect: inspect() }); continue; }
      if (command.operation === 'start-turn') {
        if (closed) { reply({ operation: 'turn_result', error: 'resident worker is closed' }); continue; }
        if (running) { reply({ operation: 'turn_result', error: 'resident worker already has a running turn' }); continue; }
        running = true;
        turnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
        unknownUsage = false;
        const text = String(command.text ?? '');
        const images = command.images as ImageContent[] | undefined;
        inFlight.push((async () => {
          try {
            await session.prompt(text, sdkPromptOptions(images));
            // The turn's usage travels back with it: §9 metering cannot charge a node whose
            // turns report nothing, and "unknown" must not be mistaken for "free".
            const snapshot = inspect();
            const usage = config.hostModel ? (unknownUsage ? undefined : turnUsage) : lastTurnUsage(snapshot);
            reply({ operation: 'turn_result', turn: { turnId: randomUUID(), text, inspect: snapshot, ...(usage ? { usage: { ...usage, ...(config.hostModel ? { accounted: true } : {}) } } : {}) } });
          } catch (error) {
            reply({ operation: 'turn_result', error: error instanceof Error ? error.message : String(error) });
          } finally {
            running = false;
          }
        })());
        continue;
      }
      if (command.operation === 'close') {
        closed = true;
        // Let any turn already running finish before the session goes away, so a node is
        // never killed mid-submission.
        await Promise.allSettled(inFlight);
        await session.close();
        await writeAll(process.stdout, `${JSON.stringify({ operation: 'closed', ...(requestId ? { requestId } : {}) })}\n`);
        process.exit(0);
      }
    }
  } finally {
    ownerLost();
    await interrupting;
    await Promise.allSettled(inFlight);
    await session.close();
    channel.destroy();
  }
  process.exit(0);
}

/**
 * Build the node's callable tools from the config the host wrote.
 *
 * Each declared tool becomes a real Pi tool whose execution is a round trip to the host:
 * the node sees an ordinary tool, but the work happens where the kernel and the
 * execution identity live (§5). A tool the config does not declare is never handed to
 * the session at all, so the model cannot call it.
 */
function forwardingTools(
  config: PiWorkerConfig,
  callHost: (name: string, args: unknown) => Promise<{ ok: boolean; text: string }>,
): ToolDefinition[] {
  const declared = config.tools ?? [];
  const allowed = new Set(config.allowedToolNames ?? []);
  return declared
    .filter(tool => allowed.size === 0 || allowed.has(tool.name))
    .map(tool => ({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines ? { promptGuidelines: tool.promptGuidelines } : {}),
      parameters: tool.parameters as never,
      async execute(_toolCallId: string, params: unknown) {
        const answer = await callHost(tool.name, params);
        // Pi catches tool exceptions and emits an error result without ending the
        // turn. Returning an isError property alone is treated as a successful call.
        if (!answer.ok) throw new Error(answer.text);
        return { content: [{ type: 'text' as const, text: answer.text }], details: {} };
      },
    }));
}

/** Write a line without truncating multibyte text: a string write can return true while its UTF-8 bytes still fill the pipe. */
export async function writeAll(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, error => { if (error) reject(error); else resolve(); });
  });
  if (stream.writableLength > 0) await once(stream, 'drain');
}
