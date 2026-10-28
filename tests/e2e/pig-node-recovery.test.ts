import { DatabaseSync } from 'node:sqlite';

import { createServer, type Server } from 'node:http';

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { execFileSync } from 'node:child_process';

import { launchCli } from '../helpers/cli-daemon.ts';
import { git, type ProviderTool, type ProviderMessage, type ProviderBody, type ProviderRequest, PROPOSAL, type LaneProvider, laneProvider, workerRequests } from "./pig-node-recovery.fixture.ts";



test('an interrupted node turn that never reached the model is sent again with the configuration it was admitted with', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-resend-'));
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
  const provider = await laneProvider({ hold: 'master' });
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;
  let state = '';
  const configPath = join(root, 'graph.config.json');
  const database = join(root, 'state/tasks.sqlite');
  try {
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { local: { secretRef: 'GRAPH_NODE_RECOVERY_KEY' } },
      // One credential slot: the master holds it while the worker waits, so
      // the worker's input is accepted by the kernel and never sent.
      limits: { credentials: { local: 1 } },
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

    // The node's input must be accepted by the kernel and never reach the
    // model: the credential slot is taken by the master.
    const admitted = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const execution = db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id='work' ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
        if (!execution) return { execution: '', admitted: false, sent: false };
        const submission = db.prepare("SELECT COUNT(*) AS n FROM graph_durable_submissions WHERE json_extract(request_id,'$') LIKE ?").get(`%${execution.id}:attempt:%`) as { n: number };
        const call = db.prepare("SELECT COUNT(*) AS n FROM kernel_provider_calls WHERE execution_id=?").get(execution.id) as { n: number };
        return { execution: execution.id, admitted: submission.n > 0, sent: call.n > 0 };
      } finally { db.close(); }
    };
    const deadlineAdmission = Date.now() + 60_000;
    while (Date.now() < deadlineAdmission && !admitted().admitted) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!admitted().admitted) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
        state = JSON.stringify({
          admitted: admitted(),
          executions: db.prepare("SELECT id,state,attempt,waiting_slot FROM kernel_executions").all(),
          queue: db.prepare("SELECT seq,node_id,state,reason FROM kernel_queue").all(),
          nodes: db.prepare("SELECT node_id,status FROM kernel_nodes").all(),
          sessions: db.prepare("SELECT instance_id,session_id FROM node_sessions").all(),
          instances: db.prepare("SELECT id,task_id,node_id FROM instances").all(),
          submissions: db.prepare("SELECT conversation_id,request_id,status FROM graph_durable_submissions").all(),
          events: (Array.isArray(events.body) ? events.body : []).slice(-30),
        }, null, 1);
      } finally { db.close(); }
    }
    expect(admitted().admitted, `the node never admitted its input:\n${state}`).toBe(true);
    expect(admitted().sent, 'the worker reached the model before the daemon died').toBe(false);
    expect(workerRequests(provider)).toHaveLength(0);

    // The catalog moves on while the daemon is down. The recovered input
    // keeps the configuration it was admitted with.
    const edited = JSON.parse(await readFile(configPath, 'utf8'));
    edited.models.entries[0].maxTokens = 4096;
    await writeFile(configPath, JSON.stringify(edited));
    daemon.child.kill('SIGKILL');
    await daemon.close();

    daemon = await start();
    // The node waits for the user: the daemon found the node interrupted and
    // did not run it on its own.
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);

    let nodeStatus = '';
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const task = await request(`/api/tasks/${taskId}`);
      const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
      nodeStatus = nodes.find(node => node.id === 'work')?.status ?? '';
      if (nodeStatus === 'succeeded') break;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (nodeStatus !== 'succeeded') {
      const events = await request(`/api/tasks/${taskId}/events?after=0&limit=400`);
      const lines = (Array.isArray(events.body) ? events.body : []).slice(-40)
        .map((event: { cursor?: number; type?: string; data?: unknown }) =>
          `${event.cursor ?? '?'} ${event.type ?? '?'} ${JSON.stringify(event.data ?? {}).slice(0, 240)}`);
      expect(nodeStatus, `events:\n${lines.join('\n')}\ndaemon:\n${daemon?.stderr ?? ''}`).toBe('succeeded');
    }
    expect(nodeStatus).toBe('succeeded');

    // The worker was asked exactly once: the accepted input was sent again,
    // not admitted twice.
    const worker = workerRequests(provider);
    expect(worker).toHaveLength(2);
    // The recovered request carries the configuration the input was admitted
    // with, not the one the catalog holds now.
    const sent = worker[0]!.body as unknown as { max_tokens?: number; max_completion_tokens?: number };
    expect(sent.max_tokens ?? sent.max_completion_tokens).toBe(512);
  } finally {
    await writeFile('/tmp/pig-node-recovery-debug.log', JSON.stringify({
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



test('an interrupted node turn that was already at the model is not sent again', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-pig-node-atmodel-'));
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
  const provider = await laneProvider({ hold: 'worker' });
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

    // The worker's turn reaches the model and stays there.
    await expect.poll(() => workerRequests(provider).length, { timeout: 60000, interval: 250 }).toBe(1);
    const atModel = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        const execution = db.prepare("SELECT id FROM kernel_executions WHERE task_id=? AND node_id='work' ORDER BY rowid DESC LIMIT 1").get(taskId) as { id: string } | undefined;
        if (!execution) return { admitted: false, sent: false };
        const submission = db.prepare("SELECT COUNT(*) AS n FROM graph_durable_submissions WHERE json_extract(request_id,'$') LIKE ?").get(`%${execution.id}:attempt:%`) as { n: number };
        const call = db.prepare("SELECT COUNT(*) AS n FROM kernel_provider_calls WHERE execution_id=?").get(execution.id) as { n: number };
        return { admitted: submission.n > 0, sent: call.n > 0 };
      } finally { db.close(); }
    };
    const deadlineModel = Date.now() + 30_000;
    while (Date.now() < deadlineModel && !atModel().sent) {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!atModel().sent) {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        state = JSON.stringify({
          atModel: atModel(),
          executions: db.prepare("SELECT id,state,attempt FROM kernel_executions").all(),
          queue: db.prepare("SELECT seq,node_id,state,reason FROM kernel_queue").all(),
        }, null, 1);
      } finally { db.close(); }
    }
    expect(atModel().sent, `the worker never reached the model:\n${state}`).toBe(true);

    daemon.child.kill('SIGKILL');
    await daemon.close();

    daemon = await start();
    // The recovery stops the turn instead of sending it again: the credential
    // was spent and the side effects may have happened.
    const stopped = () => {
      const db = new DatabaseSync(database, { readOnly: true });
      try {
        return db.prepare("SELECT state,reason FROM kernel_queue WHERE task_id=? AND node_id='work'").get(taskId) as { state: string; reason: string } | undefined;
      } finally { db.close(); }
    };
    const deadlineStopped = Date.now() + 30_000;
    while (Date.now() < deadlineStopped && stopped()?.state !== 'failed') {
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    const item = stopped();
    expect(item?.state, `the recovery did not stop the turn:\n${state}`).toBe('failed');
    expect(item?.reason ?? '').toMatch(/reconcile/i);

    // Unknown usage must be reconciled before the node may be resumed.
    const premature = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(premature.status).not.toBe(200);
    const pendingDB = new DatabaseSync(database, { readOnly: true });
    const calls = pendingDB.prepare("SELECT id FROM kernel_provider_calls WHERE task_id=? AND node_id='work' AND state='unknown'").all(taskId);
    pendingDB.close();
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      if (typeof call.id !== 'string') throw new Error('Missing pending provider call id');
      const reconciled = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'reconcile_usage', callId: call.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
      expect(reconciled.status, JSON.stringify(reconciled.body)).toBe(200);
    }
    // Resuming does not resend the interrupted input.
    const resumed = await request(`/api/tasks/${taskId}/graph/control`, 'POST', { action: 'resume', nodeId: 'work' });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    await new Promise(resolve => setTimeout(resolve, 3000));
    expect(workerRequests(provider)).toHaveLength(1);
    const task = await request(`/api/tasks/${taskId}`);
    const nodes = (task.body as { nodes?: { id: string; status: string }[] }).nodes ?? [];
    expect(nodes.find(node => node.id === 'work')?.status).not.toBe('succeeded');
  } finally {
    await writeFile('/tmp/pig-node-at-model-debug.log', JSON.stringify({
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
