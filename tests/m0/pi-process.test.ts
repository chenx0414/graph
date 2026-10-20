import { mkdtemp, mkdir, rm, writeFile, symlink, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { createAssistantMessageEventStream, getCurrentSystemPrompt } from '@earendil-works/pi-ai';
import { reply, modelA } from '../fixtures/models.ts';
import { CallBroker } from '../../src/runtime/call-broker.ts';
import { controlledOpenAIStream, type SendGate } from '../../src/runtime/controlled-openai.ts';
import { openDurableAgent } from '../fixtures/durable-agent.ts';
import { describeAgentTools } from '../../src/runtime/agent-tool-definitions.ts';
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

test('different durable agents preserve independent identities and capability prompts', async () => {
  const { root, project } = await workspace('pi-process-isolation');
  const prompts = new Map<string, string>();
  const gates = [new CallBroker(join(root, 'gate-a.sqlite'), 'agent-a'), new CallBroker(join(root, 'gate-b.sqlite'), 'agent-b')];
  cleanup.push(() => gates[0]!.close());
  cleanup.push(() => gates[1]!.close());
  const open = (id: string, gate: CallBroker, identity: string) => openDurableAgent({
    binding: { instanceId: id, nodeId: id, definitionVersion: `${id}@1` },
    workspace: project,
    stateDir: join(root, id),
    model: modelA,
    stream: (_model, context) => {
      prompts.set(id, getCurrentSystemPrompt(context.messages));
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'done', reason: 'stop', message: reply(modelA, id) });
      return stream;
    },
    tools: [],
    broker: gate,
    systemPrompt: identity,
    bundleDigest: id === 'agent-a' ? 'a'.repeat(64) : 'b'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
    readOnly: true,
  });
  const first = await open('agent-a', gates[0]!, 'Identity A');
  const second = await open('agent-b', gates[1]!, 'Identity B');
  cleanup.push(() => first.close());
  cleanup.push(() => second.close());
  const [one, two] = await Promise.all([first.prompt('one'), second.prompt('two')]);
  expect(one.inspect.binding.instanceId).toBe('agent-a');
  expect(two.inspect.binding.instanceId).toBe('agent-b');
  expect(JSON.stringify(one.inspect.messages)).not.toContain('two');
  expect(JSON.stringify(two.inspect.messages)).not.toContain('one');
  expect(prompts.get('agent-a')).toContain('Identity A');
  expect(prompts.get('agent-a')).not.toContain('Identity B');
  expect(prompts.get('agent-b')).toContain('Identity B');
  expect(prompts.get('agent-b')).not.toContain('Identity A');
}, 120_000);

test('a durable image prompt preserves the full payload above 64 KiB', async () => {
  const { root, project } = await workspace('pi-process-image');
  const gate = new CallBroker(join(root, 'gate.sqlite'), 'agent-image');
  cleanup.push(() => gate.close());
  const contexts: unknown[] = [];
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-image', nodeId: 'master', definitionVersion: 'main@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: modelA,
    stream: (_model, context) => {
      contexts.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      stream.push({ type: 'start', partial: { ...reply(modelA, ''), content: [], stopReason: 'pending' } });
      stream.push({ type: 'done', reason: 'stop', message: reply(modelA, 'I can see the image.') });
      return stream;
    },
    tools: [],
    broker: gate,
    bundleDigest: 'a'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
    readOnly: true,
  });
  cleanup.push(() => process.close());
  const image = { type: 'image' as const, mimeType: 'image/png', data: Buffer.alloc(64 * 1024, 42).toString('base64') };
  const { inspect } = await process.prompt('What is in this image?', [image]);
  expect((contexts[0] as { content?: { data?: string }[] }[]).some(message =>
    Array.isArray(message.content) && message.content.some(part => part.data === image.data))).toBe(true);
  const messages = inspect.messages as { role?: string; content?: { type?: string; text?: string }[] }[];
  expect(messages.some(message => message.role === 'assistant' && Array.isArray(message.content) &&
    message.content.some(part => part.type === 'text' && part.text === 'I can see the image.'))).toBe(true);
}, 120_000);

test('a durable agent exposes only its declared extension tool', async () => {
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
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-extension', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    piExtensionPaths: [extension],
    piExtensionTools: ['extension_probe'],
    systemPrompt: 'Use the bound extension when asked.',
    bundleDigest: 'c'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
    broker: gate,
  });
  const { inspect } = await process.prompt('Run the extension probe');
  expect(provider.requests[0]).toMatchObject({
    model: 'local',
  });
  expect(JSON.stringify(provider.requests[0])).toContain('extension_probe');
  expect(JSON.stringify(provider.requests[0])).not.toContain('secret_tool');
  expect(inspect.activeTools).not.toContain('secret_tool');
  expect(JSON.stringify(inspect.messages)).toContain('extension-probe-ok');
  expect(inspect.bundleDigest).toBe('c'.repeat(64));
  expect(inspect.activeTools).toEqual(['extension_probe']);
  await process.close();
}, 120_000);

test('a real durable graph tool returns the argument hint before executing malformed input', async () => {
  const { root, project } = await workspace('pi-process-hints');
  const gate = new CallBroker(join(root, 'gate.sqlite'), 'agent');
  cleanup.push(() => gate.close());
  const provider = await openaiServer([
    { tools: [{
      id: 'rsi-1',
      name: 'apply_rsi_change',
      arguments: JSON.stringify({
        title: 'nested',
        problem: 'the change carries a top-level field',
        changes: [{ path: 'a.ts', action: 'write', content: 'x', checks: [{ command: 'node', args: ['--run', 'check'] }] }],
      }),
    }] },
    { text: 'Understood.' },
  ]);
  cleanup.push(() => provider.close());
  const contexts: { role?: string; content?: unknown }[][] = [];
  const executed: string[] = [];
  const declaration = describeAgentTools({ rsi: { apply: true }, role: 'master' })
    .find(candidate => candidate.name === 'apply_rsi_change')!;
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-hints', nodeId: 'agent-hints', definitionVersion: 'master@1' },
    workspace: project,
    stateDir: join(root, 'agent-hints'),
    model: provider.model,
    stream: (model, context) => {
      contexts.push(structuredClone(context.messages) as { role?: string; content?: unknown }[]);
      return controlledOpenAIStream(gate, 'scripted-local-key')(model, context);
    },
    tools: [{ ...declaration, execute: async () => { executed.push('apply'); return { content: [{ type: 'text', text: 'applied' }], details: {} }; } }],
    broker: gate,
    systemPrompt: 'Identity',
    bundleDigest: 'a'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
    readOnly: false,
  });
  cleanup.push(() => process.close());
  await process.prompt('Apply the improvement');
  const toolResult = contexts[1]?.find(message => message.role === 'toolResult');
  expect(JSON.stringify(toolResult?.content)).toMatch(/nested one level too deep/);
  expect(executed).toEqual([]);
}, 120_000);

test('a bound Pi extension can load sibling modules from its capability directory', async () => {
  const { root, project } = await workspace('pi-extension-imports');
  const extensionRoot = join(root, 'extension');
  await mkdir(join(extensionRoot, 'lib'), { recursive: true });
  await writeFile(join(extensionRoot, 'index.mjs'), `
    import { value } from './lib/probe.mjs';
    export default function (pi) {
      pi.registerTool({
        name: 'extension_import_probe',
        label: 'Extension import probe',
        description: 'Return a value imported from the extension package.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: value }], details: {} };
        },
      });
    }
  `);
  await writeFile(join(extensionRoot, 'lib', 'probe.mjs'), `export const value = 'extension-import-ok';\n`);
  const provider = await openaiServer([{ text: 'The imported extension loaded.' }]);
  cleanup.push(() => provider.close());
  const gate: SendGate = new CallBroker(join(root, 'import-calls.sqlite'), 'agent-extension-imports');
  cleanup.push(() => (gate as CallBroker).close());
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-extension-imports', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'import-state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    piExtensionPaths: [join(extensionRoot, 'index.mjs')],
    piExtensionTools: ['extension_import_probe'],
    systemPrompt: 'Use the bound extension when asked.',
    bundleDigest: 'f'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
    broker: gate,
  });
  const { inspect } = await process.prompt('Load the extension');
  expect(inspect.extensionErrors).toEqual([]);
  expect(inspect.activeTools).toContain('extension_import_probe');
  await process.close();
}, 120_000);

test('a bound Pi extension remains readable when its capability directory is inside a protected host root', async () => {
  const { root, project } = await workspace('pi-extension-protected-root');
  const protectedRoot = join(root, 'protected');
  const extensionRoot = join(protectedRoot, 'extension');
  const entryDirectory = join(extensionRoot, 'dist', 'extensions', 'agent-browser');
  const scriptDirectory = join(extensionRoot, 'dist', 'scripts');
  await mkdir(entryDirectory, { recursive: true });
  await mkdir(scriptDirectory, { recursive: true });
  await writeFile(join(extensionRoot, 'capability.json'), JSON.stringify({
    id: 'protected-extension',
    kind: 'pi-extension',
    version: '1.0.0',
    name: 'Protected extension',
    entry: './dist/extensions/agent-browser/index.mjs',
  }));
  await writeFile(join(scriptDirectory, 'agent-browser-target.mjs'), `export const value = 'protected-extension-ok';\n`);
  await writeFile(join(entryDirectory, 'index.mjs'), `
    import { value } from '../../scripts/agent-browser-target.mjs';
    export default function (pi) {
      pi.registerTool({
        name: 'protected_extension_probe',
        label: 'Protected extension probe',
        description: 'Prove a protected capability directory is readable.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return { content: [{ type: 'text', text: value }], details: {} };
        },
      });
    }
  `);
  const provider = await openaiServer([{ text: 'The protected extension loaded.' }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'protected-calls.sqlite'), 'agent-protected-extension');
  cleanup.push(() => gate.close());
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-protected-extension', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    readRoots: [extensionRoot],
    piExtensionPaths: [join(entryDirectory, 'index.mjs')],
    piExtensionTools: ['protected_extension_probe'],
    systemPrompt: 'Use the protected extension.',
    bundleDigest: 'd'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
    filesystemAccess: 'host',
    protectedPaths: [protectedRoot],
    broker: gate,
  });
  const { inspect } = await process.prompt('Load the protected extension');
  expect(inspect.extensionErrors).toEqual([]);
  expect(inspect.activeTools).toContain('protected_extension_probe');
  await process.close();
}, 120_000);

test('a durable provider request uses the host-owned credential', async () => {
  const { root, project } = await workspace('pi-credential');
  const provider = await openaiServer([{ text: 'Host-owned credential' }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-credential');
  cleanup.push(() => gate.close());
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-credential', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'host-only-key'),
    tools: [],
    broker: gate,
    bundleDigest: 'd'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
  });
  await process.prompt('Use the host credential');
  expect(provider.authorizations).toEqual(['Bearer host-only-key']);
  await process.close();
}, 120_000);

test('a durable model response larger than 64 KiB persists intact', async () => {
  const { root, project } = await workspace('pi-large-response');
  const text = `large-response:${'x'.repeat(80_000)}`;
  const provider = await openaiServer([{ text }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-large-response');
  cleanup.push(() => gate.close());
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-large-response', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    broker: gate,
    bundleDigest: 'e'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
  });
  const { inspect } = await process.prompt('Return a large response');
  expect(inspect.messages.at(-1)).toMatchObject({
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text }],
  });
  await process.close();
}, 120_000);

test('a long durable streamed response emits complete ordered text deltas', async () => {
  const { root, project } = await workspace('pi-streamed-response');
  // Many deltas over a long answer: shipping the raw event list would repeat the
  // whole response once per delta and eventually exceed every string limit.
  const chunks = Array.from({ length: 8_000 }, (_, index) => `chunk-${index}; `);
  const text = chunks.join('');
  // Far past the 32 MiB worker-reply budget if every delta repeated the partial.
  expect(text.length).toBeGreaterThan(90_000);
  const provider = await openaiServer([{ chunks }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-streamed-response');
  cleanup.push(() => gate.close());
  const observed: { type?: string; assistantMessageEvent?: { type?: string; delta?: string; partial?: unknown }; message?: unknown }[] = [];
  const agent = await openDurableAgent({
    binding: { instanceId: 'agent-streamed-response', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    broker: gate,
    onEvent: event => observed.push(event as unknown as typeof observed[number]),
    bundleDigest: 'b'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
  });
  const { inspect } = await agent.prompt('Stream a long answer');
  expect(inspect.messages.at(-1)).toMatchObject({
    role: 'assistant',
    stopReason: 'stop',
    content: [{ type: 'text', text }],
  });
  const updates = observed.filter(event => event.type === 'message_update');
  // Live text still arrives delta by delta...
  expect(updates.map(event => event.assistantMessageEvent?.delta ?? '').join('')).toBe(text);
  expect(observed.some(event => event.type === 'message_end' && event.message !== undefined)).toBe(true);
  await agent.close();
}, 120_000);

test('a durable multibyte response above 64 KiB is persisted without truncation', async () => {
  const { root, project } = await workspace('pi-large-multibyte-response');
  // Keep the JavaScript string just under the stdout high-water mark while
  // making its UTF-8 representation cross the 64 KiB pipe boundary.
  const text = '你好'.repeat(31_000);
  expect(text.length).toBeLessThan(64 * 1024);
  expect(Buffer.byteLength(text)).toBeGreaterThan(64 * 1024);
  const provider = await openaiServer([{ text }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-large-multibyte-response');
  cleanup.push(() => gate.close());
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-large-multibyte-response', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    broker: gate,
    bundleDigest: 'f'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
  });
  const { inspect } = await process.prompt('Return a large multibyte response');
  const assistant = inspect.messages.at(-1) as { role?: string; stopReason?: string; content?: { type?: string; text?: string }[] };
  expect(assistant.role).toBe('assistant');
  expect(assistant.stopReason).toBe('stop');
  expect(assistant.content?.[0]?.type).toBe('text');
  expect(assistant.content?.[0]?.text).toHaveLength(text.length);
  expect(assistant.content?.[0]?.text?.slice(0, 12)).toBe('你好你好你好你好你好你好');
  expect(assistant.content?.[0]?.text?.slice(-12)).toBe('你好你好你好你好你好你好');
  await process.close();
}, 120_000);

test('a durable agent completes after receiving a large real extension result', async () => {
  const { root, project } = await workspace('pi-large-tool-result');
  const extension = join(project, 'large-extension.mjs');
  await writeFile(join(project, 'payload.txt'), 'x'.repeat(1_200_000));
  await writeFile(extension, `
    import { readFileSync } from 'node:fs';
    export default function (pi) {
      pi.registerTool({
        name: 'large_probe',
        label: 'Large probe',
        description: 'Return a large tool result.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          return {
            content: [{ type: 'text', text: readFileSync(new URL('./payload.txt', import.meta.url), 'utf8') }],
            details: {},
          };
        },
      });
    }
  `);
  const provider = await openaiServer([
    { tools: [{ id: 'large-probe', name: 'large_probe', arguments: '{}' }] },
    { text: 'The large tool result completed.' },
  ]);
  cleanup.push(() => provider.close());
  provider.model.contextWindow = 2_000_000;
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-large-tool-result');
  cleanup.push(() => gate.close());
  const process = await openDurableAgent({
    binding: { instanceId: 'agent-large-tool-result', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project,
    stateDir: join(root, 'state'),
    model: provider.model,
    stream: controlledOpenAIStream(gate, 'scripted-local-key'),
    tools: [],
    piExtensionPaths: [extension],
    piExtensionTools: ['large_probe'],
    broker: gate,
    bundleDigest: 'a'.repeat(64),
    toolPolicyDigest: '1'.repeat(64),
    runtimePolicyDigest: '2'.repeat(64),
  });
  const { inspect } = await process.prompt('Run the large probe');
  expect(provider.requests).toHaveLength(2);
  expect(inspect.messages.at(-1)).toMatchObject({
    role: 'assistant',
    content: [{ type: 'text', text: 'The large tool result completed.' }],
  });
  await process.close();
}, 120_000);

test('a durable capability rebind preserves the stable conversation and prior messages', async () => {
  const { root, project } = await workspace('durable-process-rebind');
  const provider = await openaiServer([{ text: 'Original capability reply' }, { text: 'Rebound capability reply' }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'calls.sqlite'), 'agent-rebind');
  cleanup.push(() => gate.close());
  const base = { binding: { instanceId: 'agent-rebind', nodeId: 'work', definitionVersion: 'coder@1' }, workspace: project,
    stateDir: join(root, 'state'), model: provider.model, stream: controlledOpenAIStream(gate, 'scripted-local-key'), tools: [], broker: gate,
    toolPolicyDigest: '1'.repeat(64), runtimePolicyDigest: '2'.repeat(64) };
  const first = await openDurableAgent({ ...base, bundleDigest: 'a'.repeat(64), systemPrompt: 'Original capability policy' });
  await first.prompt('Remember the original capability');
  const before = first.inspect();
  await first.close();
  const rebound = await openDurableAgent({ ...base, bundleDigest: 'b'.repeat(64), systemPrompt: 'Rebound capability policy' });
  cleanup.push(() => rebound.close());
  expect(rebound.inspect().sessionId).toBe(before.sessionId);
  expect(rebound.inspect().messages).toEqual(before.messages);
  await rebound.prompt('Continue using the rebound capability');
  expect(JSON.stringify(provider.requests[1])).toContain('Original capability reply');
  expect(JSON.stringify(provider.requests[1])).toContain('Rebound capability policy');
  expect(JSON.stringify(provider.requests[1])).not.toContain('Original capability policy');
  expect(rebound.inspect().bundleDigest).toBe('b'.repeat(64));
}, 30_000);


test.each(['symlink', 'asset', 'absolute-package', 'bare-package', 'transitive-package'])('bounded extension freezing refuses an outside %s resource before dispatch', async (kind) => {
  const { root, project } = await workspace('extension-read-boundary');
  const extensionRoot = kind === 'transitive-package' ? join(root, 'node_modules', 'approved-extension') : join(root, 'extension');
  await mkdir(extensionRoot, { recursive: true });
  const secret = 'outside-private-resource-marker';
  await writeFile(join(root, 'private.mjs'), `export const value = '${secret}';`);
  await symlink(join(root, 'private.mjs'), join(extensionRoot, 'probe.mjs'));
  await writeFile(join(extensionRoot, 'index.mjs'), kind === 'symlink'
    ? "import { value } from './probe.mjs'; export default function () {}"
    : "const asset = new URL('../private.mjs', import.meta.url); export default function () {}");
  if (kind === 'absolute-package' || kind === 'bare-package') {
    const outsidePackage = kind === 'bare-package' ? join(root, 'node_modules', 'private-package') : join(root, 'outside', 'node_modules', 'private-package');
    await mkdir(outsidePackage, { recursive: true });
    await writeFile(join(outsidePackage, 'package.json'), JSON.stringify({ name: 'private-package', version: '1.0.0', type: 'module', main: 'index.mjs' }));
    await writeFile(join(outsidePackage, 'index.mjs'), `export const value = '${secret}';`);
    await writeFile(join(extensionRoot, 'index.mjs'), `import { value } from '${kind === 'bare-package' ? 'private-package' : join(outsidePackage, 'index.mjs')}'; export default function () {}`);
  }
  if (kind === 'transitive-package') {
    await rm(join(extensionRoot, 'probe.mjs'));
    const outsidePackage = join(root, 'outside', 'private-package');
    await mkdir(outsidePackage, { recursive: true });
    await mkdir(join(extensionRoot, 'node_modules'));
    await writeFile(join(outsidePackage, 'package.json'), JSON.stringify({ name: 'private-package', version: '1.0.0', main: 'index.mjs' }));
    await writeFile(join(outsidePackage, 'index.mjs'), `export const value = '${secret}';`);
    await symlink(outsidePackage, join(extensionRoot, 'node_modules', 'private-package'));
    await writeFile(join(extensionRoot, 'package.json'), JSON.stringify({ name: 'approved-extension', version: '1.0.0', dependencies: { 'private-package': '1.0.0' } }));
    await writeFile(join(extensionRoot, 'index.mjs'), "import { value } from 'private-package'; export default function () {}");
  }
  const stateDir = join(root, 'state');
  const provider = await openaiServer([{ text: 'Must never dispatch.' }]);
  cleanup.push(() => provider.close());
  const gate = new CallBroker(join(root, 'boundary-calls.sqlite'), 'boundary');
  cleanup.push(() => gate.close());
  await expect(openDurableAgent({
    binding: { instanceId: 'boundary', nodeId: 'work', definitionVersion: 'coder@1' },
    workspace: project, stateDir, model: provider.model, tools: [],
    stream: controlledOpenAIStream(gate, 'scripted-local-key'), broker: gate,
    piExtensionPaths: [join(extensionRoot, 'index.mjs')], filesystemAccess: 'bounded',
    readRoots: [extensionRoot], systemPrompt: 'Use the declared extension.',
  })).rejects.toThrow(/read permissions|resource closure is incomplete/);
  const archive = join(stateDir, 'durable-frozen-resources');
  for (const name of await readdir(archive)) {
    if (/^[a-f0-9]{64}$/.test(name)) expect(await readFile(join(archive, name), 'utf8')).not.toContain(secret);
  }
});
