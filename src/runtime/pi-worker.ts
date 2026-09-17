import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { Socket } from 'node:net';
import {
  createAssistantMessageEventStream, InMemoryCredentialStore, Type,
  type Api, type AssistantMessageEvent, type Model,
} from '@earendil-works/pi-ai';
import type { ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { externallyGated, openPiInstance } from './pi-instance.ts';
import type { PiWorkerConfig, PiWorkerInspect } from './pi-process.ts';

interface Reply { ok: boolean; value?: unknown; error?: string }

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
    const response = await request({ operation: 'model', context, events: true }) as { events: AssistantMessageEvent[] };
    const output = createAssistantMessageEventStream();
    for (const event of response.events) output.push(event);
    return output;
  };
  const tools: ToolDefinition[] = config.tools.map(tool => externallyGated({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet ? { promptSnippet: tool.promptSnippet } : {}),
    ...(tool.promptGuidelines?.length ? { promptGuidelines: tool.promptGuidelines } : {}),
    parameters: Type.Unsafe(tool.parameters as never),
    execute: async (id, params) => await request({
      operation: 'tool', id, name: tool.name, args: params,
    }) as never,
  }));
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
    ...(config.skillPaths.length ? { skillPaths: config.skillPaths } : {}),
    ...(config.piExtensionPaths.length ? { piExtensionPaths: config.piExtensionPaths } : {}),
    piExtensionTools: config.piExtensionTools,
    extensionFactories: [capabilityGate],
    systemPrompt: config.systemPrompt,
    ...(config.appendSystemPrompt ? { appendSystemPrompt: config.appendSystemPrompt } : {}),
    hideSkillDescriptions: true,
    activateExtensionTools: true,
    capabilityDigest: config.capabilityDigest,
    ...(config.allowWorkspaceChange ? { allowWorkspaceChange: true } : {}),
    ...(config.compaction ? { compaction: config.compaction } : {}),
    onEvent: event => {
      pendingEvents.push(request({ operation: 'event', event }).catch(error => {
        process.stderr.write(`Pi event delivery failed: ${String(error)}\n`);
        throw error;
      }));
    },
  });
  const inspect = () => ({ ...session.inspect(), processId: process.pid }) as PiWorkerInspect;
  await request({ operation: 'ready', inspect: inspect() });

  let promptRunning = false;
  const runPrompt = async (text: string) => {
    if (promptRunning) throw new Error('Pi worker already has a running prompt');
    promptRunning = true;
    await session.prompt(text);
    await Promise.all(pendingEvents);
    process.stdout.write(`${JSON.stringify({ ok: true, inspect: inspect() })}\n`);
    await session.close();
    process.exit(0);
  };

  for await (const line of createInterface({ input: process.stdin })) {
    if (!line.trim()) continue;
    const command = JSON.parse(line) as { operation?: string; text?: string };
    if (command.operation === 'prompt' && typeof command.text === 'string') {
      void runPrompt(command.text).catch(error => {
        process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
        process.exit(1);
      });
    } else if (command.operation === 'steer' && typeof command.text === 'string') {
      void session.steer(command.text).catch(error => {
        process.stderr.write(`Pi steer failed: ${String(error)}\n`);
      });
    } else if (command.operation === 'close') {
      await session.close();
      process.exit(0);
    }
  }
}

main().catch(error => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.stdout.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
});
