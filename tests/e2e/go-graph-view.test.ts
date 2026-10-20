import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

/**
 * The task graph view of a real graph.
 *
 * The view places the graph on a canvas the first time it is asked for, and the
 * placement is cached in the application process. A daemon that does not have
 * that cache answers the graph route with a server error instead of the graph,
 * so this drives a real graph through the real Go process and reads the view
 * back.
 */
test('a real task answers its graph view with the graph, not a server error', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-graph-view-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div>Graph</div>');
  const plans: Parameters<typeof openaiServer>[0] = [];
  const main = await openaiServer(plans);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_GRAPH_VIEW_KEY' } },
      models: { entries: [{ id: 'main', modelId: 'main', provider: 'graph-main', grade: 'high',
        api: 'openai-completions', baseUrl: main.model.baseUrl, contextWindow: 32000, maxTokens: 256,
        credentialId: 'local' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_GRAPH_VIEW_KEY: 'synthetic-key' }, extraArgs: ['--execute'] });
    async function request(path: string, method = 'GET', data?: unknown) {
      const response = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    }
    plans.push({ tools: [{ id: 'create-graph', name: 'graph_create', arguments: JSON.stringify({
      requestId: 'create-graph', definition: {
        schemaVersion: 2, name: 'Viewable graph', protocols: { job: { type: 'object' } },
        nodes: { work: { recipe: 'worker@1', model: 'main', task: 'Do the work.', inputs: { job: { protocol: 'job' } },
          outputs: {}, submission: {} } },
        modules: {}, edges: {}, inputs: {}, outputs: {},
      } }) }] }, { text: 'The graph exists.' });
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'main', text: 'Create a graph I can look at.', requestId: 'graph-view',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;
    await expect.poll(async () => (await request(`/api/conversations/${conversationId}`)).body
      .master?.status, { timeout: 30000 }).toBe('succeeded');
    const tasks = await request('/api/tasks');
    expect(tasks.status).toBe(200);
    const graphs = (tasks.body as { id: string }[]).filter(task => task.id.length > 0);
    expect(graphs.length).toBeGreaterThan(0);
    const graphId = graphs[0]!.id;
    // The view is asked for twice: the first call places the graph and caches
    // the placement, the second one reads the cache back.
    for (const _ of [1, 2]) {
      const view = await request(`/api/tasks/${graphId}/graph`);
      expect(view.status, JSON.stringify(view.body)).toBe(200);
      const graph = view.body as { nodes: unknown[]; layout: { positions: unknown } };
      expect(Array.isArray(graph.nodes)).toBe(true);
      expect(graph.layout).toBeTruthy();
      expect(graph.layout.positions).toBeTruthy();
    }
  } finally {
    await daemon?.close();
    await main.close();
    await rm(root, { recursive: true, force: true });
  }
}, 90000);
