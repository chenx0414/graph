import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ImageContent, Model, Api } from '@earendil-works/pi-ai';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
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
    tools: [],
    nativeTools: [],
    systemPrompt: config.systemPrompt,
    allowedToolNames: [],
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
  for await (const line of commands) {
    if (!line.trim()) continue;
    let command: Record<string, unknown>;
    try { command = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    const requestId = typeof command.requestId === 'string' ? command.requestId : undefined;
    const reply = (value: Record<string, unknown>) => notify({ ...value, ...(requestId ? { requestId } : {}) });
    if (command.operation === 'inspect') { reply({ operation: 'inspect_result', inspect: inspect() }); continue; }
    if (command.operation === 'start-turn') {
      if (closed) { reply({ operation: 'turn_result', error: 'resident worker is closed' }); continue; }
      if (running) { reply({ operation: 'turn_result', error: 'resident worker already has a running turn' }); continue; }
      running = true;
      try {
        await session.prompt(String(command.text ?? ''), sdkPromptOptions(command.images as ImageContent[] | undefined));
        reply({ operation: 'turn_result', turn: { id: randomUUID(), text: String(command.text ?? ''), inspect: inspect() } });
      } catch (error) {
        reply({ operation: 'turn_result', error: error instanceof Error ? error.message : String(error) });
      } finally {
        running = false;
      }
      continue;
    }
    if (command.operation === 'close') {
      closed = true;
      await session.close();
      await writeAll(process.stdout, `${JSON.stringify({ operation: 'closed', ...(requestId ? { requestId } : {}) })}\n`);
      process.exit(0);
    }
  }
}

/** Write a line without truncating multibyte text: a string write can return true while its UTF-8 bytes still fill the pipe. */
export async function writeAll(stream: NodeJS.WriteStream, text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    stream.write(text, error => { if (error) reject(error); else resolve(); });
  });
  if (stream.writableLength > 0) await once(stream, 'drain');
}
