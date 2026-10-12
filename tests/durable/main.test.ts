import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { createDurableSessionTransport } from '../../src/runtime/durable-session.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { describeAgentTools } from '../../src/runtime/agent-tool-definitions.ts';
import { PI_NATIVE_TOOL_NAMES } from '../../src/runtime/pi-native-tools.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('public main conversation continues its actual durable model transcript after reopening the same Graph store', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-durable-main-'));
  const provider = await openaiServer([{ text: 'First persisted reply.' }, { text: 'Reply using earlier conversation.' }]);
  const agentContext = openAgentContextLibrary(join(root, 'prompts'));
  await agentContext.ensure();
  // This slice is deliberately a capability-free main. Full native/Skill/MCP
  // support is the next ticket and unsupported bindings fail explicitly.
  await agentContext.setDisabledTools([...PI_NATIVE_TOOL_NAMES, ...describeAgentTools({
    role: 'master', graphManagement: true, graphRead: true, workspaceCommit: true, run: true, fetch: true, catalog: true,
    artifacts: { allowedNamespaces: ['research'], canPromote: true }, peers: true,
    supervisor: { validateProposal: true, graphState: true, taskStatus: true, listProjects: true, bindProject: true, listProblems: true, resolveProblem: true, withdrawDraft: true, confirmDraft: true, archiveDraft: true, restoreDraft: true, deleteDraft: true, controlTask: true, pendingHumanChecks: true, reviewHumanCheck: true },
    conversations: { read: true, write: true }, systemContext: { systemSummary: true, systemDiagnostics: true, proposeSystemChange: true, applySystemChange: true }, rsi: { status: true, apply: true },
  }).map(tool => tool.name)]);
  const options = { stateDir: join(root, 'state'), sessionTransport: createDurableSessionTransport, agentContext,
    catalog: { capabilityRoot: join(root, 'graph', 'capabilities'), recipesPath: join(root, 'graph', 'recipes.json') },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high' as const, api: 'openai-completions' as const, baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'scripted-local-key', modelRuntime: provider.runtime },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
  };
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>> | undefined;
  try {
    runtime = await openTaskRuntime(options);
    const { conversationId } = await runtime.conversations.create({ text: 'Remember the phrase blue heron.', requestId: 'first' });
    await runtime.host.runReady();
    const first = await runtime.conversations.view(conversationId);
    expect(first.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('First persisted reply.');
    expect(first.master?.used).toBeGreaterThan(0);
    await runtime.close();
    runtime = await openTaskRuntime(options);
    await runtime.conversations.chat(conversationId, { text: 'Continue our discussion.', requestId: 'second' });
    await runtime.host.runReady();
    const second = await runtime.conversations.view(conversationId);
    expect(second.messages.filter(message => message.role === 'assistant').map(message => message.text)).toContain('Reply using earlier conversation.');
    expect(second.master?.used).toBeGreaterThan(first.master?.used ?? 0);
    expect(provider.requests).toHaveLength(2);
    expect(JSON.stringify(provider.requests[1])).toContain('blue heron');
    expect(JSON.stringify(provider.requests[1])).toContain('First persisted reply.');
    expect(provider.authorizations).toEqual(['Bearer scripted-local-key', 'Bearer scripted-local-key']);
  } finally { await runtime?.close(); await provider.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
