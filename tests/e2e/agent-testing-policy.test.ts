import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

test('CLI conversations and graph execution deliver the host E2E-only policy to main, workers, reviewers and suggestions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-testing-policy-'));
  const plans: Parameters<typeof openaiServer>[0] = [];
  const primary = await openaiServer(plans);
  const worker = await openaiServer([{ text: 'Worker acknowledged.' }]);
  const reviewer = await openaiServer([{ text: 'Review complete.' }]);
  const cheap = await openaiServer([{ text: 'Continue verification.' }, { text: 'Inspect the result.' }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const project = join(root, 'project');
    await mkdir(project); await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div>Graph</div>');
    const providers = { main: primary, worker, reviewer, cheap };
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_POLICY_KEY' } }, models: {
        entries: Object.entries(providers).map(([id, provider]) => ({ id, modelId: id, provider: `graph-${id}`,
          grade: id === 'cheap' ? 'low' : id === 'main' ? 'high' : 'medium', api: 'openai-completions',
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
      ['runtime/prompt-suggestion.md', '   '],
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
    await expect.poll(() => cheap.requests.length, { timeout: 30000 }).toBeGreaterThan(0);
    for (const [id, provider] of Object.entries(providers)) {
      expect(provider.requests.length, id).toBeGreaterThan(0);
      for (const sent of provider.requests) {
        const body = sent as { messages: { role: string; content: unknown }[] };
        const system = JSON.stringify(body.messages.filter(message => message.role === 'system' || message.role === 'developer'));
        if (id === 'cheap') expect(system).toContain('Write exactly one concise next message the user may want to send.');
        expect(system, id).toContain('Only author or modify end-to-end (E2E) tests. Do not write unit tests or integration tests');
        expect(system, id).toContain('do not mock owned collaborators, fabricate business receipts');
        expect(system, id).toContain('Reviewers must flag newly authored unit or integration tests');
        expect(system, id).toContain('takes precedence over conflicting recipe, skill, project or editable prompt');
      }
    }
  } finally {
    await daemon?.close();
    for (const provider of [primary, worker, reviewer, cheap]) await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
