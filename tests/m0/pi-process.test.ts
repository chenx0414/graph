import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { reply, modelA } from '../fixtures/models.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { controlledOpenAIStream, type SendGate } from '../../src/runtime/controlled-openai.ts';
import { openPiProcess } from '../../src/runtime/pi-process.ts';
import { createWorkerRequests } from '../../src/runtime/worker-requests.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

async function workspace(name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  return { root, project };
}

test('different subagents run in independent Pi processes with their own capability prompts', async () => {
  const { root, project } = await workspace('pi-process-isolation');
  const prompts = new Map<string, string>();
  const gates = [new CallBroker(join(root, 'gate-a.sqlite'), 'agent-a'), new CallBroker(join(root, 'gate-b.sqlite'), 'agent-b')];
  cleanup.push(() => gates[0]!.close());
  cleanup.push(() => gates[1]!.close());
  const open = (id: string, gate: CallBroker, identity: string, awareness: string) => openPiProcess({
    binding: { instanceId: id, nodeId: id, definitionVersion: `${id}@1` },
    workspace: project,
    stateDir: join(root, id),
    model: modelA,
    stream: (_model, context) => {
      prompts.set(id, context.systemPrompt ?? '');
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: reply(modelA, id) });
      return stream;
    },
    tools: [],
    broker: gate,
    systemPrompt: identity,
    appendSystemPrompt: awareness,
    capabilityDigest: id === 'agent-a' ? 'a'.repeat(64) : 'b'.repeat(64),
    readOnly: true,
  });
  const first = await open('agent-a', gates[0]!, 'Identity A', 'Capability A');
  const second = await open('agent-b', gates[1]!, 'Identity B', 'Capability B');
  const [one, two] = await Promise.all([first.prompt('one'), second.prompt('two')]);
  expect(one.processId).not.toBe(process.pid);
  expect(two.processId).not.toBe(process.pid);
  expect(one.processId).not.toBe(two.processId);
  expect(prompts.get('agent-a')).toContain('Identity A');
  expect(prompts.get('agent-a')).toContain('Capability A');
  expect(prompts.get('agent-a')).not.toContain('Identity B');
  expect(prompts.get('agent-b')).toContain('Identity B');
  expect(prompts.get('agent-b')).not.toContain('Capability A');
  await first.close();
  await second.close();
}, 120_000);

test('a bound Pi extension registers its declared tool inside the isolated Agent process', async () => {
  const { root, project } = await workspace('pi-extension');
  const extension = join(root, 'extension.ts');
  await writeFile(extension, `
    export default function (pi) {
      pi.registerTool({
        name: 'extension_probe',
        label: 'Extension probe',
        description: 'Return a value from the bound Pi extension.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: 'extension-probe-ok' }], details: {} };
        },
      });
      pi.registerTool({
        name: 'secret_tool',
        label: 'Secret tool',
        description: 'This tool is not declared by the capability manifest.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: 'secret-tool-ran' }], details: {} };
        },
      });
    }
  `);
  const provider = await openaiServer([
    { tools: [{ id: 'extension-1', name: 'extension_probe', arguments: '{}' }] },
    { text: 'The extension tool completed.' },
  ]);
  cleanup.push(() => provider.close());
  const gate: SendGate = new CallBroker(join(root, 'calls.sqlite'), 'agent-extension');
  cleanup.push(() => (gate as CallBroker).close());
  const process = await openPiProcess({
    binding: { instanceId: 'agent-extension', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    piExtensionPaths: [extension],
    piExtensionTools: ['extension_probe'],
    systemPrompt: 'Use the bound extension when asked.',
    appendSystemPrompt: 'extension_probe is declared by the bound Pi extension.',
    capabilityDigest: 'c'.repeat(64),
    broker: gate,
  });
  const inspect = await process.prompt('Run the extension probe');
  expect(provider.requests[0]).toMatchObject({
    model: 'local',
  });
  expect(JSON.stringify(provider.requests[0])).toContain('extension_probe');
  expect(JSON.stringify(provider.requests[0])).not.toContain('secret_tool');
  expect(inspect.activeTools).not.toContain('secret_tool');
  expect(JSON.stringify(inspect.messages)).toContain('extension-probe-ok');
  expect(inspect.capabilityDigest).toBe('c'.repeat(64));
  const host = createWorkerRequests({
    broker: gate,
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    resources: {},
    tools: {},
    allowedExtensionTools: ['extension_probe'],
  });
  expect(await host({ operation: 'tool_gate', name: 'secret_tool' })).toMatchObject({ allowed: false });
  await process.close();
}, 120_000);

test('the process host never exposes the provider credential to the Agent process', async () => {
  const { root, project } = await workspace('pi-credential');
  const provider = await openaiServer([{ text: 'Host-owned credential' }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-credential');
  cleanup.push(() => gate.close());
  const process = await openPiProcess({
    binding: { instanceId: 'agent-credential', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'host-only-key'),
    tools: [],
    broker: gate,
    capabilityDigest: 'd'.repeat(64),
  });
  await process.prompt('Use the host credential');
  expect(provider.authorizations).toEqual(['Bearer host-only-key']);
  await process.close();
}, 120_000);

test('the production process path requires and verifies the persisted capability digest', async () => {
  const { root, project } = await workspace('pi-process-digest');
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-digest');
  cleanup.push(() => gate.close());
  const base = {
    binding: { instanceId: 'agent-digest', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: modelA,
    stream: () => {
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: reply(modelA, 'digest checked') });
      return stream;
    },
    tools: [],
    broker: gate,
  };
  const first = await openPiProcess({ ...base, capabilityDigest: 'a'.repeat(64) });
  await first.prompt('first');
  await first.close();

  await expect(openPiProcess({ ...base, capabilityDigest: undefined as unknown as string })).rejects.toThrow('capability digest is required');
  await expect(openPiProcess({ ...base, capabilityDigest: 'b'.repeat(64) })).rejects.toThrow('does not match');
  const same = await openPiProcess({ ...base, capabilityDigest: 'a'.repeat(64) });
  await same.prompt('same');
  await same.close();

  const manifestPath = join(root, 'state', 'instance.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as Record<string, unknown>;
  delete manifest.capabilityDigest;
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(openPiProcess({ ...base, capabilityDigest: 'a'.repeat(64) })).rejects.toThrow('has no digest');
}, 120_000);
