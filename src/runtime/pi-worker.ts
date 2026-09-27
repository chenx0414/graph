import { readFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { Socket } from 'node:net';
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, Type,
  type Api, type AssistantMessage, type AssistantMessageFrame, type ImageContent, type Model,
} from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { prepareToolArguments } from './agent-tool-definitions.ts';
import { externallyGated, openPiInstance } from './pi-instance.ts';
import { spoolToolCall } from './tool-call-spool.ts';
import { sdkPromptOptions } from './prompt-options.ts';
import { replayAssistantStream } from './assistant-stream-frames.ts';
import type { PiWorkerConfig } from './pi-process.ts';
import type { AgentSessionInspect } from './agent-session.ts';

interface Reply { ok: boolean; value?: unknown; error?: string }

/**
 * Only the delta needs to cross the channel for live text: a `message_update`
 * carries the whole in-progress message twice (as `message` and as
 * `assistantMessageEvent.partial`), which would resend the entire response once
 * per token. Every text progress event is therefore reduced to the text the host
 * has not seen yet, which also keeps the host's accumulator exact when the frame
 * encoder folded an already-visible prefix into the block's start event. The
 * authoritative message still arrives with `message_end`.
 */
const forwardedText = new Map<number, string>();

function textBlockOf(partial: unknown, contentIndex: unknown) {
  if (!partial || typeof partial !== 'object' || Array.isArray(partial) || typeof contentIndex !== 'number') return undefined;
  const content = (partial as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const block = content[contentIndex] as { type?: unknown; text?: unknown } | undefined;
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : undefined;
}

function compactAgentEvent(event: unknown) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const record = event as Record<string, unknown>;
  // A new assistant message restarts block indexes.
  if (record.type === 'message_start') { forwardedText.clear(); return event; }
  if (record.type !== 'message_update') return event;
  const update = record.assistantMessageEvent;
  if (!update || typeof update !== 'object' || Array.isArray(update)) return event;
  const { partial, contentIndex, ...assistantMessageEvent } = update as Record<string, unknown>;
  const { message: _message, ...rest } = record;
  const text = textBlockOf(partial, contentIndex);
  if (text === undefined) return { ...rest, assistantMessageEvent };
  const index = contentIndex as number;
  const seen = assistantMessageEvent.type === 'text_start' ? '' : forwardedText.get(index) ?? '';
  const delta = text.startsWith(seen) ? text.slice(seen.length) : text;
  forwardedText.set(index, text);
  return { ...rest, assistantMessageEvent: { type: 'text_delta', contentIndex: index, delta } };
}

async function writeFully(stream: NodeJS.WriteStream, text: string) {
  // Wait for the callback, not only for `drain`. A string write can return
  // true based on the JavaScript string length while its UTF-8 representation
  // already fills the OS pipe. Calling process.exit() at that point truncates
  // the result, which is especially visible for Chinese text and emoji.
  await new Promise<void>((resolve, reject) => {
    stream.write(text, error => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (stream.writableLength > 0) await once(stream, 'drain');
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error('Pi worker config path is required');
  const config = JSON.parse(await readFile(configPath, 'utf8')) as PiWorkerConfig;
  const channel = new Socket({ fd: 3, readable: true, writable: true });
  const channelLines = createInterface({ input: channel })[Symbol.asyncIterator]();
  const waiting: { resolve: (value: unknown) => void; reject: (error: unknown) => void }[] = [];
  void (async () => {
    for await (const line of channelLines) {
      if (!line.trim()) continue;
      const reply = JSON.parse(line) as Reply;
      const pending = waiting.shift();
      if (!pending) continue;
      if (reply.ok) pending.resolve(reply.value);
      else pending.reject(new Error(reply.error ?? 'Pi host request failed'));
    }
    for (const pending of waiting.splice(0)) pending.reject(new Error('Pi host channel closed'));
  })().catch(error => {
    process.stderr.write(`${String(error)}\n`);
  });
  const request = (value: unknown) => new Promise<unknown>((resolve, reject) => {
    waiting.push({ resolve, reject });
    channel.write(`${JSON.stringify(value)}\n`);
  });

  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    allowModelNetwork: false, refreshOnCreate: false,
  });
  modelRuntime.registerProvider(config.model.provider, {
    api: config.model.api,
    baseUrl: config.model.baseUrl,
    apiKey: 'graph-host-broker-placeholder',
    models: [config.model],
  });
  const stream: import('@earendil-works/pi-agent-core').StreamFn = async (model, context) => {
    const response = await request({ operation: 'model', context, events: true }) as {
      frames: AssistantMessageFrame[];
      settlement: AssistantMessage;
    };
    const output = createAssistantMessageEventStream();
    for (const event of replayAssistantStream(response.frames, response.settlement)) output.push(event);
    return output;
  };
  // The host sent JSON, so a declaration seam that is a function cannot travel: anything the host attached
  // by value has to be re-attached here by name, or the real Agent process simply never runs it.
  const tools: ToolDefinition[] = config.tools.map(tool => {
    const prepareArguments = prepareToolArguments(tool.name);
    return externallyGated({
      name: tool.name,
      label: tool.label,
      description: tool.description,
      ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
      ...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
      ...(prepareArguments ? { prepareArguments } : {}),
      parameters: Type.Unsafe(tool.parameters as never),
      execute: async (id, params) => await request({
        operation: 'tool', id, name: tool.name, args: params,
      }) as never,
    });
  });
  const proxiedTools = new Set(config.tools.map(tool => tool.name));
  const capabilityGate: InlineExtension = {
    name: 'graph-capability-gate',
    hidden: true,
    factory: pi => {
      pi.on('tool_call', async event => {
        if (proxiedTools.has(event.toolName)) return;
        const decision = await request({
          operation: 'tool_gate',
          name: event.toolName,
          id: event.toolCallId,
        }) as { allowed?: boolean; reason?: string };
        if (decision.allowed) return;
        return { block: true, reason: decision.reason ?? 'Blocked by Graph capability gate' };
      });
    },
  };
  const pendingEvents: Promise<unknown>[] = [];
  const session = await openPiInstance({
    binding: config.binding,
    workspace: config.workspace,
    stateDir: config.stateDir,
    model: config.model as Model<Api>,
    modelRuntime,
    stream,
    thinkingLevel: config.thinkingLevel,
    tools,
    nativeTools: config.nativeTools,
    ...(config.skillPaths.length ? { skillPaths: config.skillPaths } : {}),
    ...(config.skillFolder ? { skillFolder: config.skillFolder } : {}),
    ...(config.piExtensionPaths.length ? { piExtensionPaths: config.piExtensionPaths } : {}),
    ...(config.mcpAdapterServers?.length ? { mcpAdapterServers: config.mcpAdapterServers } : {}),
    // This process holds no store: spool the call so the daemon can fold it in later.
    onToolCall: call => { void spoolToolCall(config.stateDir, config.binding.instanceId, call); },
    piExtensionTools: config.piExtensionTools,
    extensionFactories: [capabilityGate],
    systemPrompt: config.systemPrompt,
    activateExtensionTools: true,
    allowedToolNames: config.allowedToolNames,
    bundleDigest: config.bundleDigest,
    ...(config.legacyCapabilityDigest ? { legacyCapabilityDigest: config.legacyCapabilityDigest } : {}),
    toolPolicyDigest: config.toolPolicyDigest,
    runtimePolicyDigest: config.runtimePolicyDigest,
    ...(config.allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
    ...(config.freshSession ? { freshSession: true } : {}),
    ...(config.forkFrom ? { forkFrom: config.forkFrom } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
    ...(config.retry ? { retry: config.retry } : {}),
    onEvent: event => {
      pendingEvents.push(request({ operation: 'event', event: compactAgentEvent(event) }).catch(error => {
        process.stderr.write(`Pi event delivery failed: ${String(error)}\n`);
        throw error;
      }));
    },
  });
  const inspect = () => ({ ...session.inspect(), processId: process.pid }) as AgentSessionInspect & { processId: number };
  await request({ operation: 'ready', inspect: inspect() });

  const finish = async () => {
    await writeFully(process.stdout, `${JSON.stringify({ ok: true, inspect: inspect() })}\n`);
    await session.close();
    process.exit(0);
  };
  let operationRunning = false;
  const runPrompt = async (text: string, images: ImageContent[] | undefined) => {
    if (operationRunning) throw new Error('Pi worker already has a running operation');
    operationRunning = true;
    await session.prompt(text, sdkPromptOptions(images));
    await Promise.all(pendingEvents);
    await finish();
  };
  const runCompact = async (customInstructions: string | undefined, keepAlive: boolean) => {
    if (operationRunning) throw new Error('Pi worker already has a running operation');
    operationRunning = true;
    let failure: { error: string } | undefined;
    try { await session.compact(customInstructions); }
    catch (error) { failure = { error: error instanceof Error ? error.message : String(error) }; }
    await Promise.all(pendingEvents.splice(0));
    // During a source update an older daemon can launch this worker before
    // reloading. Its compact command still expects the final result on exit.
    if (!keepAlive) {
      if (failure) throw new Error(failure.error);
      await finish();
      return;
    }
    // Report both success and summary failure without ending the session.
    // The host may immediately send the user's prompt after this reply.
    operationRunning = false;
    await request({ operation: 'compaction_result', result: { ok: !failure, inspect: inspect(), ...failure } });
  };

  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const command = JSON.parse(line) as { operation?: string; text?: string; images?: ImageContent[]; keepAlive?: boolean };
    if (command.operation === 'prompt' && typeof command.text === 'string') {
      void runPrompt(command.text, Array.isArray(command.images) ? command.images : undefined).catch(async error => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        await writeFully(process.stderr, `${message}\n`).catch(() => undefined);
        process.exit(1);
      });
    } else if (command.operation === 'compact') {
      void runCompact(typeof command.text === 'string' ? command.text : undefined, command.keepAlive === true).catch(async error => {
        const message = error instanceof Error ? error.stack ?? error.message : String(error);
        await writeFully(process.stderr, `${message}\n`).catch(() => undefined);
        process.exit(1);
      });
    } else if (command.operation === 'steer' && typeof command.text === 'string') {
      void session.steer(command.text).catch(error => {
        process.stderr.write(`Pi steer failed: ${String(error)}\n`);
      });
    } else if (command.operation === 'stop') {
      void session.stop().catch(error => {
        process.stderr.write(`Pi stop failed: ${String(error)}\n`);
      });
    } else if (command.operation === 'close') {
      await finish();
    }
  }
}

main().catch(error => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  const result = JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) });
  void Promise.allSettled([
    writeFully(process.stderr, `${message}\n`),
    writeFully(process.stdout, `${result}\n`),
  ]).finally(() => process.exit(1));
});
