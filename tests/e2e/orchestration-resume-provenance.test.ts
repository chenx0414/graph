import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { DEFINITION, PROPOSAL, masterProvider, run } from './go-graph-confirmation.fixture.ts';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function field(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== 'string' || !result) throw new Error(`Missing ${key}: ${JSON.stringify(value)}`);
  return result;
}

test.each(['graph', 'task', 'work', 'global-work'])('an archived %s needs an actual current user instruction before an agent can resume it', async mode => {
  const root = await mkdtemp(join(tmpdir(), 'graph-resume-provenance-'));
  let graphID = '';
  let sourceID = '';
  let workID = '';
  let requested = false;
  let restored = false;
  const instruction = 'Please resume this graph.';
  const master = await masterProvider(body => mode === 'global-work' && !body.tools?.some(tool => tool.function?.name === 'ask_user') ? [] : [{ id: requested ? 'resume-authorized' : 'resume-automatic', name: mode === 'graph' ? 'graph_control' : mode === 'task' ? 'control_task' : 'resume_work', args: () => mode === 'task' ? ({ taskId: graphID, action: 'resume', sourceMessageId: requested ? sourceID : '', instruction: requested ? instruction : '', requestId: requested ? 'authorized-task' : 'automatic-task' }) : mode !== 'graph' ? ({ workId: workID, sourceMessageId: requested ? sourceID : '', instruction: requested ? instruction : '', requestId: requested ? 'authorized-work' : 'automatic-work' }) : ({ graphId: graphID, action: 'resume', sourceMessageId: requested ? sourceID : '', instruction: requested ? instruction : '' }), before: async () => { await expect.poll(() => restored && Boolean(graphID) && (!requested || Boolean(sourceID)), { timeout: 10_000 }).toBe(true); } }]);
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  try {
    const project = join(root, 'project');
    await mkdir(project); await mkdir(join(root, 'web'));
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
    await writeFile(join(project, 'README.md'), '# project\n');
    for (const args of [['init', '-q', '-b', 'main'], ['add', 'README.md'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@local', 'commit', '-qm', 'baseline']]) await run('git', args, { cwd: project });
    const config = join(root, 'graph.config.json');
    await writeFile(config, JSON.stringify({ version: 1, projects: [{ id: 'p', root: project }], credentials: { local: { secretRef: 'GRAPH_RESUME_KEY' } }, models: { entries: [{ id: 'main', provider: 'graph-master', grade: 'high', api: 'openai-completions', maxTokens: 256, credentialId: 'local', contextWindow: 32000, baseUrl: master.baseUrl }] } }));
    daemon = await launchCli(root, { configPath: config, extraArgs: ['--execute'], env: { GRAPH_RESUME_KEY: 'synthetic-key' } });
    async function request(path: string, body?: object) {
      if (!daemon) throw new Error('Daemon unavailable');
      const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
      const value: unknown = await response.json();
      expect(response.status, JSON.stringify(value)).toBe(200);
      return record(value);
    }
    const projectConversation = field(await request('/api/projects/p/thread', { requestId: 'project' }), 'conversationId');
    const conversation = mode === 'global-work' ? field(await request('/api/orchestration/global', { requestId: 'global' }), 'conversationId') : projectConversation;
    if (mode === 'work' || mode === 'global-work') {
      const source = field(await request(`/api/conversations/${conversation}/messages`, { text: 'Build the feature.', requestId: 'initial' }), 'messageId');
      workID = field(await request('/api/orchestration/work', { conversationId: conversation, projectId: 'p', sourceMessageId: source, brief: 'Build a feature', acceptance: ['Feature works'], requestId: 'work' }), 'id');
      await request(`/api/orchestration/work/${workID}/drafts`, { requestId: 'draft', workRevision: 1, proposal: PROPOSAL });
      graphID = field(await request(`/api/orchestration/work/${workID}/confirm`, { workRevision: 1, version: 1, draftRevision: 1, graphKey: 'main', requestId: 'confirm', targetBranch: 'main' }), 'graphId');
    } else graphID = field(await request('/api/graphs', { conversationId: conversation, definition: DEFINITION, targetBranch: 'main', requestId: 'graph' }), 'graphId');
    await request('/api/projects/p/archive', { requestId: 'archive' });
    await request('/api/projects/p/restore', { requestId: 'restore' });
    restored = true;
    await request(`/api/conversations/${conversation}/messages`, { text: 'Explain the current status.', requestId: 'status' });
    await expect.poll(() => master.results.has('resume-automatic'), { timeout: 20_000 }).toBe(true);
    expect(master.results.get('resume-automatic')).toContain('current user');
    expect(await request(`/api/tasks/${graphID}`)).toMatchObject({ paused: true });
    if (mode === 'work' || mode === 'global-work') expect(await request(`/api/orchestration/work/${workID}`)).toMatchObject({ executionPaused: true });
    await expect.poll(async () => record((await request(`/api/conversations/${conversation}`)).master).status, { timeout: 10_000 }).toBe('succeeded');
    requested = true;
    sourceID = field(await request(`/api/conversations/${conversation}/messages`, { text: instruction, requestId: 'resume' }), 'messageId');
    await expect.poll(() => master.results.has('resume-authorized'), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await request(`/api/tasks/${graphID}`)).paused, { timeout: 10_000 }).toBe(false);
    if (mode === 'work' || mode === 'global-work') expect(await request(`/api/orchestration/work/${workID}`)).toMatchObject({ executionPaused: false });
  } finally {
    await daemon?.close(); await master.close(); await rm(root, { recursive: true, force: true });
  }
}, 60_000);
