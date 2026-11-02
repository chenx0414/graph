import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { withExtension, type ConversationView } from '../helpers/pi-extension-fixture.ts';

// A real Pi extension: the module a Pi extension package ships, loaded by Pi's
// own extension loader. It registers one tool and watches every tool call.
//
// The extension runs in a Node process of its own, so the file it writes when
// its tool really runs is the proof that the call reached the extension.
const extensionSource = `import { writeFileSync } from 'node:fs';

export default function (pi) {
  pi.registerTool({
    name: 'proof_tool',
    description: 'Return a fixed proof string.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      if (process.env.GRAPH_PIG_PI_EXTENSION_MARKER) {
        writeFileSync(process.env.GRAPH_PIG_PI_EXTENSION_MARKER, 'the extension ran');
      }
      return { content: [{ type: 'text', text: 'extension-proof' }] };
    },
  });
  pi.on('tool_call', async () => undefined);
}
`;

// The same extension with a hook that refuses the call it watches. The tool
// body must never run: the refusal happens before it.
const guardedExtensionSource = `import { writeFileSync } from 'node:fs';

export default function (pi) {
  pi.registerTool({
    name: 'guarded_tool',
    description: 'A tool the extension refuses to run.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      if (process.env.GRAPH_PIG_PI_EXTENSION_MARKER) {
        writeFileSync(process.env.GRAPH_PIG_PI_EXTENSION_MARKER, 'the extension ran');
      }
      return { content: [{ type: 'text', text: 'should never run' }] };
    },
  });
  pi.on('tool_call', async (event) => {
    if (event && event.toolName === 'guarded_tool') {
      return { block: true, reason: 'the extension refuses this call' };
    }
    return undefined;
  });
}
`;

// A bound Pi extension really runs on the PiG kernel.
//
// The extension lives in a Node process of its own: the model is offered the
// tool the extension registered, the call reaches the extension, and the
// extension's own answer is what the model reads. Nothing about the extension
// is simulated - the file it writes when its tool runs is the proof.
test('a bound Pi extension runs its own tool on the PiG kernel', async () => {
  await withExtension(extensionSource, [{ name: 'proof_tool', description: 'Return a fixed proof string.' }], async ({ daemon, provider, capabilityDirectory }) => {
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Call the proof tool.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    await expect.poll(async () => (await view()).master?.status, { timeout: 60000, interval: 250 }).toBe('succeeded');

    // The model was offered the tool the extension registered.
    const declared = (provider.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? [];
    expect(declared.map(tool => tool.function?.name)).toContain('proof_tool');
    // The call reached the extension: it ran, and it wrote its own file.
    expect(existsSync(join(capabilityDirectory, 'tool-ran.txt'))).toBe(true);
    // An extension tool call is telemetry like any other: without this row a
    // later "who called agent_browser" has no answer.
    const stats = await (await daemon.request('/api/tool-stats')).text();
    expect(stats).toContain('proof_tool');
    // The extension's own answer is what the model read.
    expect(JSON.stringify(provider.requests[1])).toContain('extension-proof');
    const answers = (await view()).messages?.filter(message => message.role === 'assistant') ?? [];
    expect(answers.at(-1)?.text).toContain('The extension answered.');
  });
}, 120000);

// The extension's own hook refuses a call, and the tool body never runs.
//
// The hook is Pi's own: a handler that returns {block: true, reason} refuses
// the call. Graph keeps the admission - the extension owns the body of the
// tool, not the right to call it.
test('a Pi extension hook refuses a call before the tool body runs', async () => {
  await withExtension(guardedExtensionSource, [{ name: 'guarded_tool', description: 'A tool the extension refuses to run.' }], async ({ daemon, provider, capabilityDirectory }) => {
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Call the guarded tool.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    await expect.poll(async () => (await view()).master?.status, { timeout: 60000, interval: 250 }).toBe('succeeded');

    // The model was offered the tool, and the extension's refusal is what it
    // read instead of the tool's answer.
    const declared = (provider.requests[0] as { tools?: { function?: { name?: string } }[] }).tools ?? [];
    expect(declared.map(tool => tool.function?.name)).toContain('guarded_tool');
    expect(JSON.stringify(provider.requests[1])).toContain('the extension refuses this call');
    // The body never ran: the extension did not write its file.
    expect(existsSync(join(capabilityDirectory, 'tool-ran.txt'))).toBe(false);
  });
}, 120000);

// A session whose policy is narrower than the daemon's own reach may not
// host a Pi extension.
//
// The extension's process has the daemon's reach: it reads and writes the host
// and reaches the network. A session that may not do that itself may not host
// an extension either - running one would widen the session behind its
// policy's back. The refusal says so instead of running it anyway.
test('a session with a narrow policy refuses the bound Pi extension by name', async () => {
  await withExtension(extensionSource, [{ name: 'proof_tool', description: 'Return a fixed proof string.' }], async ({ daemon, provider }) => {
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Call the proof tool.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    await expect.poll(async () => (await view()).messages?.filter(message => message.kind === 'error').length,
      { timeout: 60000, interval: 250 }).toBe(1);

    // The model was never asked anything: the agent could not start.
    expect(provider.requests).toHaveLength(0);
    const failure = (await view()).messages?.find(message => message.kind === 'error');
    expect(failure?.text).toContain('Pi extension');
    expect(failure?.text).toContain('proof@1.0.0');
    // The problem is parked for main, with the reason.
    const question = (await view()).questions?.find(entry => entry.kind === 'execution_failed');
    expect(question?.owner).toBe('main');
    expect(question?.data?.output?.setupError).toContain('narrower than the daemon');
  }, { mode: 'standard' });
}, 120000);

// A closed extension host leaves no process behind.
//
// Measured 2026-11-02: an extension keeps module state for as long as its
// process lives, so a process inherited by the next host arrives "already
// initialized" and never initializes again. pi-fff is the visible case - its
// search is built on session start and torn down on shutdown, and after that
// teardown every call answers "FFF picker factory is not initialized" while the
// tool itself keeps working. Closing a host has to mean the process is gone.
const pidExtensionSource = `import { writeFileSync } from 'node:fs';

export default function (pi) {
  pi.registerTool({
    name: 'proof_tool',
    description: 'Record the pid of the extension process that answered.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => {
      if (process.env.GRAPH_PIG_PI_EXTENSION_MARKER) {
        writeFileSync(process.env.GRAPH_PIG_PI_EXTENSION_MARKER, String(process.pid));
      }
      return { content: [{ type: 'text', text: 'extension-proof' }] };
    },
  });
}
`;

test('a reloaded extension host runs the extension in a new process', async () => {
  await withExtension(pidExtensionSource, [{ name: 'proof_tool', description: 'Record the pid of the extension process that answered.' }], async ({ daemon, provider, capabilityDirectory }) => {
    const marker = join(capabilityDirectory, 'tool-ran.txt');
    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Call the proof tool.', requestId: 'pid-first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon.request(`/api/conversations/${conversationId}`)).json() as ConversationView;
    await expect.poll(async () => (await view()).master?.status, { timeout: 60000, interval: 250 }).toBe('succeeded');
    const first = await readFile(marker, 'utf8');
    expect(first.trim()).toMatch(/^\d+$/);

    // The turn is settled, so the host can be replaced the way the console does.
    const reloaded = await daemon.request('/api/extensions/reload', { method: 'POST', body: JSON.stringify({ requestId: 'pid-reload' }) });
    expect(reloaded.status).toBe(200);

    const second = await daemon.request(`/api/conversations/${conversationId}/messages`, {
      method: 'POST', body: JSON.stringify({ text: 'Call the proof tool again.', requestId: 'pid-second' }),
    });
    expect(second.status).toBe(200);
    await expect.poll(async () => (await view()).messages?.filter(message => message.role === 'assistant').length, { timeout: 60000, interval: 250 })
      .toBeGreaterThanOrEqual(2);

    const next = await readFile(marker, 'utf8');
    expect(next.trim()).toMatch(/^\d+$/);
    // The second host must not adopt the process the first one used: that
    // process carries the state the closed host was supposed to drop.
    expect(next.trim()).not.toBe(first.trim());
    // Both turns really reached an extension process.
    expect((provider.requests as { tools?: { function?: { name?: string } }[] }[]).length).toBeGreaterThanOrEqual(2);
  }, undefined, [
    { tools: [{ id: 'call-proof', name: 'proof_tool', arguments: JSON.stringify({}) }] },
    { text: 'The extension answered.' },
    { tools: [{ id: 'call-proof-again', name: 'proof_tool', arguments: JSON.stringify({}) }] },
    { text: 'The extension answered again.' },
  ]);
}, 180_000);
