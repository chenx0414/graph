import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { TaskStore } from '../../src/core/store.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
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
  const noiseStore = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(() => noiseStore.close());
  noiseStore.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('noise','/tmp/noise','[]');
    INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq)
      VALUES('noise-task','noise','NOISE_PROJECT_SENTINEL',1,0,'running',0,999);
    INSERT INTO nodes(task_id,id,spec,status)
      VALUES('noise-task','noise-node','{"id":"noise-node","kind":"program","action":"noise"}','failed');
    INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,status,owner)
      VALUES('noise-question','noise-task','noise-node',NULL,'execution_failed','{"reason":"NOISE_PROBLEM_SENTINEL"}','open','main');
  `);

  const created = await runtime.conversations.create({
    text: '把 Semantic Scholar MCP 加进资源库。',
    requestId: 'system-self-create',
  });
  await runtime.host.runReady();
  expect(JSON.stringify(provider.requests[1])).toContain('capabilityHealth');
  expect(JSON.stringify(provider.requests[1])).not.toContain('NOISE_PROJECT_SENTINEL');
  expect(JSON.stringify(provider.requests[1])).not.toContain('NOISE_PROBLEM_SENTINEL');
  expect(JSON.stringify(provider.requests[1])).not.toContain('configuredModels');
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

test('full access auto-approves a capability proposal and lets the same Main Agent apply it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-system-auto-approval-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const capabilityRoot = join(root, 'graph', 'capabilities');
  const proposalChange = {
    kind: 'capability',
    capability: {
      manifest: {
        id: 'auto-approved-mcp',
        kind: 'mcp',
        version: '1.0.0',
        name: 'Auto Approved MCP',
        description: 'A capability installed through full access mode',
        url: 'https://example.test/mcp',
      },
    },
  };
  let runtime: Awaited<ReturnType<typeof openTaskRuntime>>;
  const provider = await openaiServer([
    {
      tools: [{
        id: 'propose-system-change',
        name: 'propose_system_change',
        arguments: JSON.stringify({
          title: '安装自动批准 MCP',
          problem: '完全访问模式下应自动批准系统变更。',
          changeJson: JSON.stringify(proposalChange),
          impact: '后续配方可以绑定它。',
          risk: '仅测试。',
        }),
      }],
    },
    {
      tools: [{
        id: 'apply-system-change',
        name: 'apply_system_change',
        arguments: () => {
          const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
          const row = store.db.prepare(
            "SELECT json_extract(data,'$.proposalId') AS proposalId FROM questions WHERE kind='system_change' ORDER BY rowid DESC LIMIT 1",
          ).get() as { proposalId?: string } | undefined;
          store.close();
          if (!row?.proposalId) throw new Error('Auto-approved proposal is not available yet');
          return JSON.stringify({ proposalId: row.proposalId });
        },
      }],
    },
    { text: '自动批准并安装完成。' },
  ]);
  cleanup.push(() => provider.close());
  runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    access: () => fullAccessPolicy(),
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
    text: '安装自动批准 MCP。',
    requestId: 'system-auto-create',
  });
  await runtime.host.runReady();
  const view = await runtime.conversations.view(created.conversationId);
  expect(view.questions.find(question => question.kind === 'system_change')).toMatchObject({
    status: 'resolved',
    answer: { type: 'respond', value: { decision: 'approved' } },
  });
  expect(runtime.catalog.capability('auto-approved-mcp')).toMatchObject({
    id: 'auto-approved-mcp',
    status: 'available',
  });
}, 120_000);
