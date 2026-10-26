import { DatabaseSync } from 'node:sqlite';

import { createServer, type Server } from 'node:http';

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { execFileSync } from 'node:child_process';

import { launchCli } from '../helpers/cli-daemon.ts';
import { git, type ProviderTool, type ProviderMessage, type ProviderBody, type ProviderRequest, PROPOSAL, type LaneProvider, laneProvider, workerRequests } from "./pig-node-recovery.fixture.ts";



test('an interrupted node turn the kernel already finished settles the node without asking the model again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-finished-'));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await mkdir(join(project, 'test'), { recursive: true });
  await writeFile(join(project, 'test', 'check.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'README.md'), '# Node recovery project\n');
  git(project, ['init', '-q', '-b', 'main']);
  git(project, ['config', 'user.email', 'graph@example.invalid']);
  git(project, ['config', 'user.name', 'Graph Test']);
  git(project, ['add', '.']);
  git(project, ['commit', '-q', '-m', 'initial']);
  const provider = await laneProvider({ hold: 'none' });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let state = '';
  const configPath = join(root, 'graph.config.json');
  const database = join(root, 'state/tasks.sqlite');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_RECOVERY_KEY' } },
      models: { entries: [{ id: 'local', provider: 'graph-node-recovery', grade: 'high',
        api: 'openai-completions', baseUrl: provider.baseUrl, contextWindow: 32000, maxTokens: 512,
        credentialId: 'local' }] },
    }));
    const start = () => launchCli(root, { configPath, env: { GRAPH_NODE_RECOVERY_KEY: 'synthetic-only' }, extraArgs: ['--execute', '--kernel', 'pig'] });
    daemon = await start();
    const request = async (path: string, method = 'GET', data?: unknown) => {
      const reply = await daemon!.request(path, { method, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: reply.status, body: await reply.json().catch(() => ({})) };
    };
    // The Graph cannot record the node's completion. The kernel still finishes
    // the turn: the turn is the kernel's, and only the acknowledgement is the
    // Graph's.
    const fault = new DatabaseSync(join(root, 'state/tasks.sqlite'));
    fault.exec("PRAGMA busy_timeout=5000; CREATE TRIGGER reject_node_completion BEFORE UPDATE OF state ON kernel_executions WHEN NEW.state='completed' BEGIN SELECT RAISE(ABORT, 'E2E storage acknowledgement failure'); END");
    fault.close();
    const created = await request('/api/conversations', 'POST', {
      projectId: 'p', model: 'local', text: 'Make a graph with one worker.', requestId: 'lane-1',
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    const conversationId = (created.body as { conversationId: string }).conversationId;

    let draft: { version?: number; draftRevision?: number; targetBranch?: string } = {};
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      const proposal = (view.body as { proposal?: { version?: number; draftRevision?: number; targetBranch?: string } }).proposal;
      draft = proposal ?? {};
      return Boolean(proposal);
    }, { timeout: 60000, interval: 250 }).toBe(true);
    await expect.poll(async () => {
      const view = await request(`/api/conversations/${conversationId}`);
      return (view.body as { master?: { status?: string } }).master?.status;
    }, { timeout: 90000, interval: 500 }).toBe('succeeded');

    const confirmed = await request(`/api/conversations/${conversationId}/confirm`, 'POST', {
      proposalVersion: draft.version ?? 1, draftRevision: draft.draftRevision ?? 1,
      targetBranch: draft.targetBranch ?? 'main', requestId: 'lane-confirm',
    });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    const taskId = (confirmed.body as { taskId: string }).taskId;
    expect(taskId).toBeTruthy();

    // The kernel finishes the turn: the worker submitted and answered.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && workerRequests(provider).length < 2) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (workerRequests(provider).length < 2) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        state = JSON.stringify({
          worker: workerRequests(provider).length,
          executions: db.prepare("SELECT id,state,attempt FROM kernel_executions").all(),
          submissions: db.prepare("SELECT conversation_id,request_id,status FROM graph_durable_submissions").all(),
        }, null, 1);
      } finally { db.close(); }
    }
    expect(workerRequests(provider).length, `the worker never finished its turn:\n${state}`).toBe(2);
    // The Graph could not record the completion, so the node is still running.
    await expect.poll(async () => {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      return nodes.find(node => node.id === 'work')?.status;
    }, { timeout: 30000, interval: 250 }).not.toBe('succeeded');

    daemon.child.kill('SIGKILL');
    await daemon.close();
    const repair = new DatabaseSync(database);
    repair.exec('PRAGMA busy_timeout=5000; DROP TRIGGER reject_node_completion');
    repair.close();

    daemon = await start();
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

    let nodeStatus = '';
    const settle = Date.now() + 90_000;
    while (Date.now() < settle) {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      nodeStatus = nodes.find(node => node.id === 'work')?.status ?? '';
      if (nodeStatus === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (nodeStatus !== 'succeeded') {
      const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-30)
        .map((event: { cursor?: number; type?: string; data?: unknown }) =>
          `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 240)}`);
      expect(nodeStatus, `events:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe('succeeded');
    }
    expect(nodeStatus).toBe('succeeded');
    // The kernel kept the answer it already had. The model was not asked
    // again.
    expect(workerRequests(provider)).toHaveLength(2);
  } finally {
    await writeFile('/tmp/pig-node-finished-debug.log', JSON.stringify({
      requests: provider.requests.map(entry => ({
        master: entry.master,
        tools: (entry.body.tools ?? []).map(tool => tool.function?.name),
      })),
      state,
      stderr: daemon?.stderr ?? '',
    }, null, 2));
    await daemon?.close();
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300000);
