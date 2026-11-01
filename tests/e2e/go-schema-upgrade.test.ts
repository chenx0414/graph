import { DatabaseSync } from 'node:sqlite';

import { createServer, type Server } from 'node:http';

import type { AddressInfo } from 'node:net';

import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { fileURLToPath } from 'node:url';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';
import { FIXTURES, SCHEMA_VERSION, type ToolCall, type ChatMessage, type ChatBody, readDb, columnsOf, UPGRADE_DEFINITION, type MasterCall, masterProvider, nodeProvider } from "./go-schema-upgrade.fixture.ts";



for (const fixture of ['v13', 'v17'] as const) {
  test(`a real ${fixture} state directory is upgraded in place, keeps its history and still runs a native graph`, async () => {
    const root = await mkdtemp(join(tmpdir(), `graph-e2e-go-upgrade-${fixture}-`));
    const stateDir = join(root, 'state');
    await mkdir(stateDir, { recursive: true });
    await cp(join(FIXTURES, `${fixture}-tasks.sqlite`), join(stateDir, 'tasks.sqlite'));
    const projectRoot = join(root, 'legacy-project');
    await mkdir(projectRoot, { recursive: true });
    await writeFile(join(projectRoot, 'legacy.txt'), 'legacy workspace file\n');
    await mkdir(join(root, 'web'), { recursive: true });
    await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');

    // Point the persisted legacy project at this workspace and add a task that
    // has lost its nodes but kept its history. No migration runs here: the
    // daemon is the one that upgrades.
    {
      const raw = new DatabaseSync(join(stateDir, 'tasks.sqlite'));
      raw.exec(`UPDATE projects SET root='${projectRoot.replace(/'/g, "''")}' WHERE id='legacy'`);
      raw.exec("INSERT INTO tasks(id,project_id,request,graph_version,created_seq) VALUES('history-only-task','legacy','Archived DAG',1,2)");
      raw.exec("INSERT INTO graph_revisions(task_id,version,spec,reason) VALUES('history-only-task',1,'{\"requirementVersion\":1,\"summary\":\"Archived DAG\",\"nodes\":[],\"acceptance\":[]}', 'Retained history')");
      raw.close();
    }
    const dbPath = join(stateDir, 'tasks.sqlite');
    const inodeBefore = (await stat(dbPath)).ino;

    const master = await masterProvider(graphId => [
      { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: UPGRADE_DEFINITION } },
      { id: 'send', name: 'graph_send', args: { graphId, nodeId: 'work', input: 'job', value: { upgraded: true } } },
      { id: 'results', name: 'graph_inspect', args: { graphId, query: 'results' },
        until: results => (results.get('results') ?? '').includes('upgraded') },
    ]);
    const node = await nodeProvider();
    const configPath = join(root, 'graph.config.json');
    const entry = { api: 'openai-completions', grade: 'medium', maxTokens: 256, credentialId: 'upgrade' };
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'legacy', root: projectRoot }],
      credentials: { upgrade: { secretRef: 'GRAPH_UPGRADE_KEY' } },
      models: { entries: [
        { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
        { ...entry, id: 'local', provider: 'graph-node', modelId: 'node-model', baseUrl: node.baseUrl, contextWindow: 32000 },
      ] },
    }));

    let daemon = await launchCli(root, { configPath, env: { GRAPH_UPGRADE_KEY: 'upgrade-synthetic' }, extraArgs: ['--execute'] });
    const request = async <T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> => {
      const response = await daemon.request(path, init);
      return { status: response.status, body: await response.json().catch(() => ({})) as T };
    };

    // The old task is retired, not deleted: it is still readable and it is
    // stopped, so nothing dispatches it again.
    const legacy = await request<{ id: string; phase: string }>('/api/tasks/legacy-task');
    expect(legacy.status, JSON.stringify(legacy.body)).toBe(200);
    expect(legacy.body.id).toBe('legacy-task');
    expect(legacy.body.phase).toBe('stopped');
    // The task that only has history is still there too.
    const history = await request<{ id: string }>('/api/tasks/history-only-task');
    expect(history.status).toBe(200);
    const tasks = await request<{ id: string }[]>('/api/tasks');
    expect(tasks.body.map(task => task.id)).toContain('legacy-task');
    expect(tasks.body.map(task => task.id)).toContain('history-only-task');

    // The configuration of the upgraded installation is alive: a save applies.
    const before = await request<{ revision: number }>('/api/config');
    const saved = await request<{ applied: boolean; restartRequired: boolean; revision: number }>('/api/config', {
      method: 'POST',
      body: JSON.stringify({
        expectedRevision: before.body.revision,
        document: {
          version: 1,
          projects: [{ id: 'legacy', root: projectRoot }],
          credentials: { upgrade: { secretRef: 'GRAPH_UPGRADE_KEY' } },
          models: { entries: [
            { ...entry, id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', baseUrl: master.baseUrl, contextWindow: 32000 },
            { ...entry, id: 'local', provider: 'graph-node', modelId: 'node-model', baseUrl: node.baseUrl, contextWindow: 32000 },
            { ...entry, id: 'local-2', provider: 'graph-node', modelId: 'node-model-2', baseUrl: node.baseUrl, contextWindow: 32000 },
          ] },
        },
      }),
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ applied: true, restartRequired: false });
    const after = await request<{ revision: number; config: { models: { entries: { id: string }[] } } }>('/api/config');
    expect(after.body.revision).toBeGreaterThan(before.body.revision);
    expect(after.body.config.models.entries.map(entry => entry.id)).toContain('local-2');

    await daemon.close();

    // The upgrade happened in the same file: no delete-and-recreate.
    expect((await stat(dbPath)).ino).toBe(inodeBefore);
    const upgraded = readDb(dbPath, db => ({
      version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      instance: db.prepare("SELECT budget,used,models_used FROM instances WHERE id='legacy-instance'").get(),
      cost: db.prepare("SELECT cost FROM invocations WHERE id='legacy-inv'").get(),
      pauseColumns: columnsOf(db, 'nodes').filter(column => column.startsWith('pause') || column.startsWith('user_wait')),
      conversationColumns: columnsOf(db, 'conversations'),
      bindingColumns: columnsOf(db, 'agent_context_bindings'),
      scopeColumns: columnsOf(db, 'budget_scopes'),
      questionColumns: columnsOf(db, 'questions'),
      artifactColumns: columnsOf(db, 'artifacts'),
      handoffColumns: columnsOf(db, 'context_handoffs'),
      tasks: db.prepare('SELECT id,phase FROM tasks ORDER BY id').all(),
      revisions: db.prepare("SELECT task_id FROM graph_revisions WHERE task_id='history-only-task'").all(),
    }));
    expect(upgraded.version).toBe(SCHEMA_VERSION);
    // The accounting of the old run survived the upgrade.
    expect(upgraded.instance).toMatchObject({ budget: 20_000_000, used: 12345, models_used: '["legacy-model"]' });
    expect(upgraded.cost).toMatchObject({ cost: '{"amount":0.001,"currency":"USD"}' });
    // The old task was stopped, not erased.
    expect(upgraded.tasks).toEqual(expect.arrayContaining([{ id: 'legacy-task', phase: 'stopped' }]));
    expect(upgraded.tasks).toEqual(expect.arrayContaining([{ id: 'history-only-task', phase: expect.any(String) }]));
    expect(upgraded.revisions).toEqual([{ task_id: 'history-only-task' }]);
    // The columns the newer runtime needs are really there.
    expect(upgraded.pauseColumns.sort()).toEqual(['pause_ms', 'pause_since', 'user_wait_ms', 'user_wait_since']);
    expect(upgraded.conversationColumns).toEqual(expect.arrayContaining(['archived_at', 'thinking_level']));
    expect(upgraded.bindingColumns).toEqual(expect.arrayContaining(['model_policy_digest', 'tool_policy_digest']));
    expect(upgraded.scopeColumns).toContain('root_task_id');
    expect(upgraded.questionColumns).toContain('owner');
    expect(upgraded.artifactColumns).toEqual(expect.arrayContaining(['artifact_id', 'version', 'namespace', 'digest', 'object_path']));

    // The upgraded database is not a museum piece: a native graph runs in it.
    daemon = await launchCli(root, { configPath, env: { GRAPH_UPGRADE_KEY: 'upgrade-synthetic' }, extraArgs: ['--execute'] });
    const created = await request<{ conversationId: string }>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ projectId: 'legacy', model: 'main', text: 'Run a graph in the upgraded database.', requestId: 'upgrade-begin' }),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(200);
    await expect.poll(() => master.results.get('results'), { timeout: 120_000, interval: 250 }).toContain('upgraded');
    expect(master.results.get('results')).toContain('"upgraded":true');

    await daemon.close();
    await master.close();
    await node.close();
    await rm(root, { recursive: true, force: true });
  }, 300_000);
}



test('v23 renumbers legacy handoffs before enforcing one version per task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-upgrade-v22-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  await cp(join(FIXTURES, 'v22-tasks.sqlite'), join(stateDir, 'tasks.sqlite'));
  const projectRoot = join(root, 'legacy-project');
  await mkdir(projectRoot, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  {
    const raw = new DatabaseSync(join(stateDir, 'tasks.sqlite'));
    raw.exec(`UPDATE projects SET root='${projectRoot.replace(/'/g, "''")}' WHERE id='legacy'`);
    raw.close();
  }
  const dbPath = join(stateDir, 'tasks.sqlite');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'legacy', root: projectRoot }],
    credentials: { upgrade: { secretRef: 'GRAPH_UPGRADE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', modelId: 'local', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'upgrade' }] },
  }));

  const daemon = await launchCli(root, { configPath, env: { GRAPH_UPGRADE_KEY: 'upgrade-synthetic' }, extraArgs: ['--execute'] });
  await daemon.close();

  // The three handoffs all carried version 1; the migration renumbers them
  // before the one-version-per-task index can be enforced.
  const upgraded = readDb(dbPath, db => ({
    version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    handoffs: db.prepare("SELECT id,version FROM context_handoffs WHERE id IN ('h1','h2','h3') ORDER BY version").all(),
  }));
  expect(upgraded.version).toBe(SCHEMA_VERSION);
  expect(upgraded.handoffs).toEqual([
    { id: 'h1', version: 1 }, { id: 'h2', version: 2 }, { id: 'h3', version: 3 },
  ]);
  await rm(root, { recursive: true, force: true });
}, 120_000);



test('v41 drafts and confirmation provenance survive migration and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-go-upgrade-v41-'));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: projectRoot }],
    credentials: { upgrade: { secretRef: 'GRAPH_UPGRADE_KEY' } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', modelId: 'local', grade: 'high', api: 'openai-completions',
      baseUrl: 'http://127.0.0.1:1/v1', contextWindow: 32000, maxTokens: 256, credentialId: 'upgrade' }] },
  }));
  const dbPath = join(stateDir, 'tasks.sqlite');

  // The daemon creates the current schema; the rows of an older draft are
  // written into it and the draft columns are taken away again, so the next
  // startup has to migrate them back.
  const first = await launchCli(root, { configPath, env: { GRAPH_UPGRADE_KEY: 'upgrade-synthetic' }, extraArgs: ['--execute'] });
  await first.close();
  {
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('anchor','p','Discuss',1,'chatting');
      INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('feature','p','Confirmed task',2,'running');
      INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at)
        VALUES('c','p','anchor','Draft conversation',1,100);
      INSERT INTO proposals(task_id,version,requirement_version,spec,decision_snapshot)
        VALUES('anchor',1,1,'{"summary":"Original draft"}','Keep existing behavior');
      INSERT INTO conversation_acceptances(conversation_id,proposal_version,task_id,target_branch,accepted_at)
        VALUES('c',1,'feature','main',123);
      ALTER TABLE proposals DROP COLUMN draft_revision;
      ALTER TABLE proposals DROP COLUMN draft_digest;
      ALTER TABLE proposals DROP COLUMN archived_at;
      ALTER TABLE proposals DROP COLUMN deleted_at;
      ALTER TABLE conversation_acceptances DROP COLUMN draft_revision;
      DROP TABLE node_questions;
      DROP TABLE graph_preparation_pauses;
      DROP TABLE project_archive_pauses;
      ALTER TABLE questions DROP COLUMN route_stage;
      ALTER TABLE questions DROP COLUMN route_revision;
      -- asked_at arrives with schema 52: a v41 database does not have it yet.
      ALTER TABLE questions DROP COLUMN asked_at;
      DROP TABLE work_graphs;
      ALTER TABLE projects DROP COLUMN archived_at;
      DROP TABLE work_drafts;
      DROP TABLE work_request_revisions;
      DROP TABLE work_requests;
      DROP TRIGGER conversations_role_insert;
      DROP TRIGGER conversations_role_update;
      DROP INDEX conversations_one_global;
      DROP INDEX conversations_one_project;
      ALTER TABLE conversations DROP COLUMN role;
      PRAGMA user_version=41;
    `);
    raw.close();
  }

  // Open twice: the first startup upgrades, the second must accept the schema
  // it wrote.
  for (const open of [1, 2]) {
    const daemon = await launchCli(root, { configPath, env: { GRAPH_UPGRADE_KEY: 'upgrade-synthetic' }, extraArgs: ['--execute'] });
    await daemon.close();
    const upgraded = readDb(dbPath, db => ({
      version: (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      proposals: db.prepare('SELECT task_id,version,requirement_version,spec,decision_snapshot,draft_revision,draft_digest,archived_at,deleted_at FROM proposals').all(),
      acceptances: db.prepare('SELECT conversation_id,proposal_version,task_id,target_branch,accepted_at,draft_revision FROM conversation_acceptances').all(),
    }));
    expect(upgraded.version, `open ${open}`).toBe(SCHEMA_VERSION);
    expect(upgraded.proposals, `open ${open}`).toEqual([{
      task_id: 'anchor', version: 1, requirement_version: 1,
      spec: '{"summary":"Original draft"}', decision_snapshot: 'Keep existing behavior',
      draft_revision: 1, draft_digest: null, archived_at: null, deleted_at: null,
    }]);
    expect(upgraded.acceptances, `open ${open}`).toEqual([{
      conversation_id: 'c', proposal_version: 1, task_id: 'feature', target_branch: 'main',
      accepted_at: 123, draft_revision: null,
    }]);
  }
  await rm(root, { recursive: true, force: true });
}, 180_000);
