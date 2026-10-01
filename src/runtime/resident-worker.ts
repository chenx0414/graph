import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ImageContent, Model, Api } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import { openPiInstance } from './pi-instance.ts';
import { controlledOpenAIStream } from './controlled-openai.ts';
import { sdkPromptOptions } from './prompt-options.ts';
import type { AgentSessionInspect } from './agent-session.ts';
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
  const outbox: unknown[] = [];
  let flushScheduled = false;
  const notify = (value: Record<string, unknown>) => {
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
      const requestId = `tool-${randomUUID()}`;
      toolPending.set(requestId, resolve);
      notify({ operation: 'tool_call', requestId, name, args });
    });

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
  const stream = controlledOpenAIStream(permissiveGate, 'spike-credential', undefined, 'openai-completions');

  const session = await openPiInstance({
    binding: config.binding,
    workspace: config.workspace,
    stateDir: config.stateDir,
    model: config.model as Model<Api>,
    modelRuntime,
    stream,
    thinkingLevel: config.thinkingLevel,
    tools: forwardingTools(config, (name, args) => callHost(name, args)),
    nativeTools: config.nativeTools ?? [],
    // A forwarding tool makes no model call, so it reserves nothing from the send gate.
    // The gate exists to meter model traffic; the host meters whatever the call does.
    broker: { dispatch: <T>(_id: string, _reservation: number, send: () => T): T => send(), settle: (): void => undefined },
    systemPrompt: config.systemPrompt,
    // The host declares which tools this node may call; an empty list means the node
    // offered tools are exactly the ones the host named, so passing it through is what
    // makes them callable at all (HB-262).
    allowedToolNames: config.allowedToolNames ?? [],
    bundleDigest: config.bundleDigest,
    toolPolicyDigest: config.toolPolicyDigest,
    runtimePolicyDigest: config.runtimePolicyDigest,
    ...(config.freshSession ? { freshSession: true } : {}),
    onEvent: event => { notify({ operation: 'event', event }); },
  });
  const inspect = () => ({ ...session.inspect(), processId: process.pid }) as AgentSessionInspect & { processId: number };

  let running = false;
  let closed = false;
  notify({ operation: 'ready', inspect: inspect() });

  const commands = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  // The reader must stay responsive WHILE a turn runs: a tool the node calls is answered
  // by the host on this same stdin, so blocking the reader to await the turn would
  // deadlock — the turn waits for the tool result, and the tool result waits for the
  // reader (HB-262). Each command is therefore handled without holding the loop.
  const inFlight: Promise<void>[] = [];
  for await (const line of commands) {
    if (!line.trim()) continue;
    let command: Record<string, unknown>;
    try { command = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const requestId = typeof command.requestId === 'string' ? command.requestId : undefined;
    const reply = (value: Record<string, unknown>) => notify({ ...value, ...(requestId ? { requestId } : {}) });
    // The host's answer to a tool call this node made (HB-262).
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
      const text = String(command.text ?? '');
      const images = command.images as ImageContent[] | undefined;
      inFlight.push((async () => {
        try {
          await session.prompt(text, sdkPromptOptions(images));
          reply({ operation: 'turn_result', turn: { id: randomUUID(), text, inspect: inspect() } });
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
        // A refusal is returned as the tool's result so the model can correct itself
        // rather than losing the turn to an exception (§5).
        return { content: [{ type: 'text' as const, text: answer.text }], details: {}, ...(answer.ok ? {} : { isError: true }) };
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
