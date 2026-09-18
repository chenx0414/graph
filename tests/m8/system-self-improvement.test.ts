import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

test('an unbound Main Agent can propose, receive approval, and install a capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-system-self-improvement-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const proposalChange = {
    kind: 'capability',
    capability: {
      manifest: {
        id: 'semantic-scholar',
        kind: 'mcp',
        version: '1.0.0',
        name: 'Semantic Scholar',
        description: 'Semantic Scholar MCP',
        command: 'uvx',
        args: ['semantic-scholar-mcp'],
        networkDomains: ['api.semanticscholar.org'],
      },
    },
  };
  let approvedProposalId = '';
  const provider = await openaiServer([
    {
      tools: [{
        id: 'inspect-system',
        name: 'inspect_graph_system',
        arguments: '{}',
      }],
    },
    {
      tools: [{
        id: 'propose-system-change',
        name: 'propose_system_change',
        arguments: JSON.stringify({
          title: '安装 Semantic Scholar MCP',
          problem: '资源库中缺少 Semantic Scholar MCP，文献检索只能依赖普通 Skill。',
          changeJson: JSON.stringify(proposalChange),
          impact: '后续 Agent 配方可以直接绑定该 MCP。',
          risk: '首次启动 MCP 时需要允许 uvx 下载对应包。',
        }),
      }],
    },
    { text: '已提交系统优化，等待你批准。' },
    {
      tools: [{
        id: 'apply-system-change',
        name: 'apply_system_change',
        arguments: () => JSON.stringify({ proposalId: approvedProposalId }),
      }],
    },
    { text: '批准的 MCP 已安装并通过能力库校验。' },
  ]);
  cleanup.push(() => provider.close());
  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    models: {
      entries: [{
        id: 'local',
        provider: 'graph-openai',
        grade: 'high',
        api: 'openai-completions',
        baseUrl: provider.model.baseUrl,
        contextWindow: 32_000,
        maxTokens: 256,
      }],
      apiKey: 'scripted-local-key',
      modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: 'master@1', model: 'local' },
    catalog: { capabilityRoot, recipesPath: join(root, 'graph', 'agent-combinations.json') },
    systemContext: {
      systemSummary: async () => ({
        configuredModels: [{ id: 'local', grade: 'high' }],
        capabilities: { root: capabilityRoot, entries: 0 },
      }),
    },
  });
  cleanup.push(() => runtime.close());
  runtime.catalog.publishDefinition('master', { recommendedGrade: 'high' }, 'master');

  const created = await runtime.conversations.create({
    text: '把 Semantic Scholar MCP 加进资源库。',
    requestId: 'system-self-create',
  });
  await runtime.host.runReady();
  expect(JSON.stringify(provider.requests[1])).toContain('capabilityHealth');
  let view = await runtime.conversations.view(created.conversationId);
  const proposal = view.questions.find(question => question.kind === 'system_change');
  expect(proposal).toMatchObject({
    status: 'open',
    owner: 'user',
    data: expect.objectContaining({
      title: '安装 Semantic Scholar MCP',
      change: expect.objectContaining({ kind: 'capability' }),
    }),
  });
  expect(runtime.catalog.capability('semantic-scholar')).toBeUndefined();

  const proposalId = String((proposal!.data as { proposalId?: string }).proposalId);
  approvedProposalId = proposalId;
  await runtime.user.task(view.anchorTaskId).answer(proposal!.id, {
    type: 'respond',
    value: { decision: 'approved', proposalId },
  }, 'system-self-approve');

  await runtime.host.runReady();

  view = await runtime.conversations.view(created.conversationId);
  expect(view.questions.find(question => question.id === proposal!.id)?.status).toBe('resolved');
  expect(runtime.catalog.capability('semantic-scholar')).toMatchObject({
    id: 'semantic-scholar',
    kind: 'mcp',
    version: '1.0.0',
    status: 'available',
  });
  expect(view.messages.filter(message => message.role === 'assistant').at(-1)?.text).toContain('已安装');
}, 120_000);
