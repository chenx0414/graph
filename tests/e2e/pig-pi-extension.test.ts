import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

// A real Pi extension: the module a Pi extension package ships, loaded by Pi's
// own extension loader. It registers one tool and watches every tool call.
const extensionSource = `export default function (pi) {
  pi.registerTool({
    name: 'proof_tool',
    description: 'Return a fixed proof string.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: 'text', text: 'extension-proof' }] }),
  });
  pi.on('tool_call', async () => undefined);
}
`;

interface ConversationMessage { role?: string; kind?: string; text?: string }
interface ConversationQuestion {
  kind?: string; owner?: string; status?: string;
  data?: { output?: { setupError?: string; error?: string }; retryVerdict?: string };
}
interface ConversationView {
  master?: { status?: string };
  messages?: ConversationMessage[];
  questions?: ConversationQuestion[];
}
interface TaskEvent { type?: string }

// A bound Pi extension must never disappear without a word.
//
// The PiG kernel carries Graph's own tools and the native MCP channel, but it
// hosts no Pi extension yet: the extension model PiG ships is a subprocess
// wire, and Graph's durable harness does not reach it. A capability that binds
// a Pi extension therefore cannot be honored on this kernel - and the honest
// answer to that is a refusal that names the extension, not a session that
// quietly runs without the tools the model was promised.
//
// The turn must therefore fail, and the reason must say which capability to
// unbind. What must never happen is a turn that succeeds as if the extension
// were not bound at all.
test('a bound Pi extension is refused by the PiG kernel rather than silently dropped', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-pi-extension-'));
  const project = join(root, 'project');
  const home = join(root, 'graph-home');
  await mkdir(project);
  await mkdir(join(root, 'web'));
  await mkdir(home);
  await writeFile(join(root, 'web/index.html'), '<!doctype html><div>Graph</div>');

  // The capability the recipe binds: a real Pi extension on disk.
  const capabilityDirectory = join(home, 'capabilities', 'pi-extension', 'proof-1.0.0');
  await mkdir(capabilityDirectory, { recursive: true });
  await writeFile(join(capabilityDirectory, 'index.mjs'), extensionSource);
  await writeFile(join(capabilityDirectory, 'capability.json'), JSON.stringify({
    id: 'proof', kind: 'pi-extension', version: '1.0.0', name: 'Proof extension',
    entry: './index.mjs',
    tools: [{ name: 'proof_tool', description: 'Return a fixed proof string.' }],
  }));
  // The recipe the master definition is compiled from.
  await writeFile(join(home, 'agent-combinations.json'), JSON.stringify({
    version: 1,
    combinations: [{
      id: 'main', name: 'Main', description: 'The main agent with a Pi extension.',
      recommendedGrade: 'high', review: false, tags: [],
      resources: [{ resourceId: 'proof', version: '1.0.0', role: 'pi-extension', required: false }],
    }],
  }));

  const provider = await openaiServer([
    { text: 'The proof tool is not needed.', usage: { prompt_tokens: 20, completion_tokens: 5 } },
  ]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_PIG_PI_EXTENSION_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-main', grade: 'high', api: 'openai-completions',
        baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' }] } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_PIG_PI_EXTENSION_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });

    const compiled = await daemon.request('/api/catalog/combinations/main/compile', { method: 'POST' });
    expect(compiled.status).toBe(200);

    const created = await daemon.request('/api/conversations', { method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Call the proof tool.', requestId: 'first' }) });
    expect(created.status).toBe(200);
    const { conversationId } = await created.json() as { conversationId: string };
    const view = async () => await (await daemon!.request(`/api/conversations/${conversationId}`)).json() as ConversationView;

    // The turn cannot be honored, and it says so. The failure arrives as an
    // error message in the conversation.
    await expect.poll(async () => (await view()).messages?.filter(message => message.kind === 'error').length,
      { timeout: 30000, interval: 250 }).toBe(1);
    const conversation = await view();
    const failure = conversation.messages?.find(message => message.kind === 'error');
    expect(failure?.role).toBe('system');
    // The reason names the kind of capability and the one to unbind. A path
    // would not do: the user has to change the recipe, not the filesystem.
    expect(failure?.text).toContain('Pi extension');
    expect(failure?.text).toContain('proof@1.0.0');

    // The problem is parked for main to handle, with the same reason. The
    // agent never started, so the runtime words it as a setup failure.
    const question = conversation.questions?.find(entry => entry.kind === 'execution_failed');
    expect(question?.owner).toBe('main');
    expect(question?.status).toBe('open');
    expect(question?.data?.output?.setupError).toContain('proof@1.0.0');

    // The agent produced no answer: the turn was refused before the model was
    // consulted. Nothing was spent on a turn that could not run.
    expect(conversation.messages?.some(message => message.role === 'assistant')).toBe(false);
    expect(provider.requests).toHaveLength(0);

    // The model was never offered the extension's tool, so the extension can
    // never have been reached by the model.
    for (const request of provider.requests as { tools?: { function?: { name?: string } }[] }[]) {
      expect((request.tools ?? []).map(tool => tool.function?.name)).not.toContain('proof_tool');
    }

    // The refusal settles the turn. It is not re-dispatched in a loop: one
    // operation, one intent, one failure.
    const events = await (await daemon!.request(`/api/conversations/${conversationId}/events?limit=200`)).json() as TaskEvent[];
    expect(events.filter(event => event.type === 'operation.intent')).toHaveLength(1);
    expect(events.filter(event => event.type === 'operation.result')).toHaveLength(1);
  } finally {
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120000);
