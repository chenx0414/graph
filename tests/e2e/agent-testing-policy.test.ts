import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('CLI conversations and graph execution deliver the test-first policy to main, workers and reviewers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-testing-policy-'));
  const plans: Parameters<typeof openaiServer>[0] = [];
  const primary = await openaiServer(plans);
  const worker = await openaiServer([{ text: 'Worker acknowledged.' }]);
  const reviewer = await openaiServer([{ text: 'Review complete.' }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const project = join(root, 'project');
    await mkdir(project); await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div>Graph</div>');
    const providers = { main: primary, worker, reviewer };
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_POLICY_KEY' } }, models: {
        entries: Object.entries(providers).map(([id, provider]) => ({ id, modelId: id, provider: `graph-${id}`,
          grade: id === 'main' ? 'high' : 'medium', api: 'openai-completions',
          baseUrl: provider.model.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'local' })) } }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_POLICY_KEY: 'synthetic-policy-key', PI_CODING_AGENT_DIR: join(root, 'pi') }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      expect(response.status, await response.clone().text()).toBe(200);
      return response.json();
    }
    for (const [key, content] of [
      ['rules/common.md', 'CUSTOM_COMMON_SENTINEL: write isolated unit tests.'],
      ['rules/worker.md', 'CUSTOM_WORKER_SENTINEL: use integration tests.'],
    ]) await request('/api/agent-context/prompts', 'PUT', { key, content });
    for (const [id, review] of [['worker', false], ['review', true]] as const) {
      await request('/api/catalog/combinations', 'POST', { combination: { id, name: id, description: id,
        recommendedGrade: 'medium', review, tags: [], resources: [], systemPrompt: `CUSTOM_${id}_IDENTITY` } });
      await request(`/api/catalog/combinations/${id}/compile`, 'POST', {});
    }
    plans.push({ tools: [{ id: 'create-policy-graph', name: 'graph_create', arguments: JSON.stringify({ requestId: 'create-policy-graph', definition: {
      schemaVersion: 2, name: 'Testing policy', protocols: { job: { type: 'object' } }, nodes: {
        worker: { recipe: 'worker@1', model: 'worker', task: 'Implement the assigned work.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} },
        review: { recipe: 'review@1', model: 'reviewer', task: 'Review independently.', inputs: { job: { protocol: 'job' } }, outputs: {}, submission: {} },
      }, modules: {}, edges: {}, inputs: {}, outputs: {},
    } }) }] }, { text: 'Main acknowledged.' });
    const conversation = await request('/api/conversations', 'POST', { projectId: 'p', model: 'main', text: 'Create the testing policy graph.', requestId: 'policy-main' });
    await expect.poll(async () => (await request(`/api/conversations/${conversation.conversationId}`)).master.status, { timeout: 30000 }).toBe('succeeded');
    const graphs = await request('/api/tasks');
    expect(graphs).toHaveLength(1);
    const graphId = graphs[0].id;
    plans.push({ tools: ['worker', 'review'].map(nodeId => ({ id: `send-${nodeId}`, name: 'graph_send',
      arguments: JSON.stringify({ graphId, nodeId, input: 'job', value: {} }) })) }, { text: 'Work and review dispatched.' });
    await request(`/api/conversations/${conversation.conversationId}/messages`, 'POST', { text: 'Run the work and independent review.', requestId: 'policy-dispatch' });
    for (const nodeId of ['worker', 'review']) {
      await expect.poll(async () => (await request(`/api/tasks/${graphId}/nodes/${nodeId}/run`)).node.status, { timeout: 30000 }).toBe('succeeded');
    }
    const everyRequest = Object.entries(providers).flatMap(([id, provider]) => provider.requests.map(sent => ({ id, sent })));
    for (const id of ['main', 'worker', 'reviewer']) {
      expect(providers[id as keyof typeof providers].requests.length, id).toBeGreaterThan(0);
    }
    for (const { id, sent } of everyRequest) {
      const body = sent as { messages: { role: string; content: unknown }[] };
      const system = JSON.stringify(body.messages.filter(message => message.role === 'system' || message.role === 'developer'));
      expect(system, id).toContain('Unit, integration and end-to-end tests are all allowed');
      expect(system, id).toContain('write the test before the code');
      expect(system, id).toContain('do not weaken an existing check to obtain a pass');
      expect(system, id).toContain('takes precedence over conflicting recipe, skill, project or editable prompt');
    }
  } finally {
    await daemon?.close();
    for (const provider of [primary, worker, reviewer]) await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
