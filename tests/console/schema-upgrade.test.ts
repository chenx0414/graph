import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { TaskStore, SCHEMA_VERSION } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });
const fixtures = fileURLToPath(new URL('../fixtures/legacy', import.meta.url));
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

async function prepare(fixture: string, name: string) {
  const root = await mkdtemp(join(tmpdir(), `graph-upgrade-${name}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stateDir = join(root, 'state');
  await mkdir(stateDir, { recursive: true });
  await cp(join(fixtures, `${fixture}-tasks.sqlite`), join(stateDir, 'tasks.sqlite'));
  const projectRoot = join(root, 'legacy-project');
  // Point the persisted legacy project at this temporary workspace without
  // running any migration here (raw SQLite, so phase A still upgrades).
  const raw = new DatabaseSync(join(stateDir, 'tasks.sqlite'));
  raw.exec(`UPDATE projects SET root='${projectRoot.replace(/'/g, "''")}' WHERE id='legacy'`);
  // A retired graph may have lost its nodes/proposals while retaining history.
  // It is still a DAG graph, not an external main conversation anchor.
  raw.exec(`INSERT INTO tasks(id,project_id,request,graph_version,created_seq)
    VALUES('history-only-task','legacy','Archived DAG',1,2);
    INSERT INTO graph_revisions(task_id,version,spec,reason)
    VALUES('history-only-task',1,'{"requirementVersion":1,"summary":"Archived DAG","nodes":[],"acceptance":[]}',
      'Retained history');`);
  raw.close();
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, 'legacy.txt'), 'legacy workspace file\n');
  const web = join(root, 'web');
  await mkdir(web, { recursive: true });
  await writeFile(join(web, 'index.html'), '<!doctype html><html><body>Graph</body></html>');
  return { root, stateDir, projectRoot, web, dbPath: join(stateDir, 'tasks.sqlite') };
}

async function inspect(dbPath: string) {
  const store = new TaskStore(dbPath);
  try {
    return {
      version: (store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
      instance: store.db.prepare("SELECT budget,used,unlimited,models_used FROM instances WHERE id='legacy-instance'").get() as { budget: number; used: number; unlimited: number; models_used: string },
      cost: store.db.prepare("SELECT cost FROM invocations WHERE id='legacy-inv'").get() as { cost: string },
      pauseColumns: (store.db.prepare('PRAGMA table_info(nodes)').all() as { name: string }[]).map(column => column.name).filter(column => column.startsWith('pause') || column.startsWith('user_wait')),
      conversationColumns: (store.db.prepare('PRAGMA table_info(conversations)').all() as { name: string }[]).map(column => column.name),
      bindingColumns: (store.db.prepare('PRAGMA table_info(agent_context_bindings)').all() as { name: string }[]).map(column => column.name),
      resolutionColumns: (store.db.prepare('PRAGMA table_info(context_resolutions)').all() as { name: string }[]).map(column => column.name),
      scopeColumns: (store.db.prepare('PRAGMA table_info(budget_scopes)').all() as { name: string }[]).map(column => column.name),
      resultHandoffColumns: (store.db.prepare('PRAGMA table_info(result_handoffs)').all() as { name: string }[]).map(column => column.name),
      questionColumns: (store.db.prepare('PRAGMA table_info(questions)').all() as { name: string }[]).map(column => column.name),
      artifactColumns: (store.db.prepare('PRAGMA table_info(artifacts)').all() as { name: string }[]).map(column => column.name),
      preparation: store.db.prepare("SELECT state,repo_root,baseline_sha FROM project_preparation WHERE project_id='legacy'").get() as { state: string; repo_root: string; baseline_sha: string } | undefined,
      newNodes: store.db.prepare("SELECT COUNT(*) AS count FROM node_entries WHERE task_id<>'legacy-task'").get() as { count: number },
    };
  } finally { store.close(); }
}

for (const fixture of ['v13', 'v17'] as const) {
  test(`a real ${fixture} state directory discards old graphs, preserves configuration and runs a native graph in the same database (C03)`, async () => {
    const provider = await openaiServer([
      { tools: [{ id: 'submit', name: 'submit', arguments: JSON.stringify({ outputs: { result: { enable: true, value: { upgraded: true } } } }) }] },
      { text: 'Native upgrade worker finished' },
    ]);
    cleanup.push(() => provider.close());
    const { stateDir, projectRoot, web, dbPath } = await prepare(fixture, fixture);
    const inodeBefore = (await stat(dbPath)).ino;
    const configPath = join(stateDir, '..', 'graph.config.json');
    const document = (revision: number, extraModel: boolean) => ({
      version: 1,
      revision,
      projects: [{ id: 'legacy', root: projectRoot }],
      models: { entries: [
        { id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
        ...(extraModel ? [{ id: 'local-2', provider: 'graph-openai', grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] : []),
      ] },
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    });
    await writeFile(configPath, JSON.stringify(document(0, false), null, 2));

    // Startup retires the old graph before serving requests or binding models.
    const daemon = await startGraphDaemon({ configPath, stateDir, webDir: web, port: 0, mode: 'execute', dynamic: true, env: { GRAPH_LOCAL_KEY: 'synthetic' }, log: () => undefined });
    let daemonClosed = false;
    cleanup.push(async () => { if (!daemonClosed) await daemon.close(); });
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
    const taskView = await fetch(`${daemon.url}/api/tasks/legacy-task`, { headers });
    expect(taskView.status).toBe(400);
    expect(await taskView.json()).toMatchObject({ code: 'not_found' });
    const tasks = await (await fetch(`${daemon.url}/api/tasks`, { headers })).json() as { id: string }[];
    expect(tasks.map(task => task.id)).not.toContain('legacy-task');
    expect(tasks.map(task => task.id)).not.toContain('history-only-task');
    const historyView = await fetch(`${daemon.url}/api/tasks/history-only-task`, { headers });
    expect(historyView.status).toBe(400);
    expect(await historyView.json()).toMatchObject({ code: 'not_found' });
    const configBefore = await (await fetch(`${daemon.url}/api/config`, { headers })).json() as { revision: number };
    const saveResponse = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: configBefore.revision, document: document(configBefore.revision, true) }) });
    expect(saveResponse.status).toBe(200);
    const applied = await saveResponse.json() as { applied: boolean; restartRequired: boolean; revision: number };
    expect(applied).toMatchObject({ applied: true, restartRequired: false });
    const configAfter = await (await fetch(`${daemon.url}/api/config`, { headers })).json() as { revision: number; config: { models: { entries: { id: string }[] } } };
    expect(configAfter.revision).toBeGreaterThan(configBefore.revision);
    expect(configAfter.config.models.entries.map(entry => entry.id)).toContain('local-2');
    await daemon.close(); daemonClosed = true;

    const upgraded = await inspect(dbPath);
    expect(upgraded.version).toBe(SCHEMA_VERSION);
    expect(upgraded.instance).toBeUndefined();
    expect(upgraded.cost).toBeUndefined();
    expect(upgraded.pauseColumns.sort()).toEqual(['pause_ms', 'pause_since', 'user_wait_ms', 'user_wait_since']);
    expect(upgraded.conversationColumns).toEqual(expect.arrayContaining(['archived_at', 'thinking_level']));
    expect(upgraded.bindingColumns).toEqual(expect.arrayContaining(['model_policy_digest', 'tool_policy_digest']));
    expect(upgraded.resolutionColumns).toEqual(expect.arrayContaining(['constraints_digest', 'review_policy', 'predecessor_policy']));
    expect(upgraded.scopeColumns).toContain('root_task_id');
    expect(upgraded.resultHandoffColumns).toEqual(expect.arrayContaining([
      'operation_id', 'activation_id', 'output_version', 'schema_kind', 'body', 'digest',
    ]));
    expect(upgraded.questionColumns).toContain('owner');
    expect(upgraded.artifactColumns).toEqual(expect.arrayContaining([
      'artifact_id', 'version', 'scope', 'namespace', 'digest', 'object_path', 'producer_operation_id',
    ]));

    // The upgraded infrastructure admits native interface delivery, not a DAG conversion.
    const runtimeOptions = {
      stateDir, projects: [{ id: 'legacy', root: projectRoot }],
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'synthetic', modelRuntime: provider.runtime },
      limits: { defaultBudgetTokens: 20_000_000 },
    } satisfies Parameters<typeof openTaskRuntime>[0];
    let runtime = await openTaskRuntime(runtimeOptions);
    cleanup.push(() => runtime.close());
    await installPresets(runtime.catalog, presetsRoot);
    const { taskId } = await runtime.user.begin({ projectId: 'legacy', request: 'Upgrade chain worker', requestId: 'upgrade-begin' });
    const main = runtime.supervisor(taskId);
    const { graphId } = await main.graphCreate({ definition: parseGraphDefinition({ schemaVersion: 2, name: 'Native upgrade',
      protocols: { data: { type: 'object', required: ['upgraded'], properties: { upgraded: { type: 'boolean' } } } },
      nodes: { work: { recipe: 'coder@1', model: 'local', task: 'Submit the upgrade result', inputs: { job: { protocol: 'data' } },
        outputs: { result: { protocol: 'data' } }, submission: { required: ['result'] } } }, modules: {}, edges: {},
      outputs: { result: { from: 'work.result', protocol: 'data' } },
    }) }) as { graphId: string };
    await main.graphSend({ graphId, nodeId: 'work', input: 'job', value: { upgraded: true } });
    await runtime.host.drive();
    const executions = await main.graphInspect({ graphId, query: 'executions' }) as { items: { state: string }[] };
    expect(executions.items).toEqual([expect.objectContaining({ state: 'completed' })]);
    expect(provider.requests).toHaveLength(2);
    const results = await main.graphInspect({ graphId, query: 'results' }) as { value: unknown }[];
    expect(results).toEqual([expect.objectContaining({ value: { upgraded: true } })]);
    const after = await inspect(dbPath);

    expect(after.newNodes.count).toBeGreaterThan(0);
    // Same file throughout: no delete-and-recreate migration.
    expect((await stat(dbPath)).ino).toBe(inodeBefore);
    expect(after.instance).toBeUndefined();
    await runtime.close();
    runtime = await openTaskRuntime(runtimeOptions);
    await runtime.host.drive();
    const reopened = runtime.supervisor(taskId);
    expect(await reopened.graphInspect({ graphId, query: 'results' })).toEqual(results);
    expect(await reopened.graphInspect({ graphId, query: 'executions' })).toEqual(executions);
    expect(provider.requests).toHaveLength(2);
    const disk = new TaskStore(dbPath);
    try {
      expect(disk.db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(disk.db.prepare("SELECT id FROM tasks WHERE id='legacy-task'").get()).toBeUndefined();
      expect(disk.db.prepare("SELECT id FROM tasks WHERE id='history-only-task'").get()).toBeUndefined();
      expect(disk.db.prepare("SELECT task_id FROM graph_revisions WHERE task_id='history-only-task'").all()).toEqual([]);
    } finally { disk.close(); }
  }, 120_000);
}

test('v23 renumbers legacy handoffs before enforcing one version per task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-upgrade-v22-handoffs-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'tasks.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE tasks(id TEXT PRIMARY KEY,conversation_id TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY,anchor_task_id TEXT);
    CREATE TABLE proposals(task_id TEXT,version INTEGER,requirement_version INTEGER,spec TEXT,decision_snapshot TEXT);
    CREATE TABLE conversation_acceptances(conversation_id TEXT,proposal_version INTEGER,task_id TEXT,target_branch TEXT,accepted_at INTEGER);
    CREATE TABLE nodes(task_id TEXT,spec TEXT);
    CREATE TABLE events(cursor INTEGER PRIMARY KEY,task_id TEXT,type TEXT,data TEXT,timestamp INTEGER);
    CREATE TABLE operations(id TEXT PRIMARY KEY,task_id TEXT,node_id TEXT,state TEXT);
    CREATE TABLE invocations(operation_id TEXT);
    CREATE TABLE node_capabilities(operation_id TEXT);
    CREATE TABLE messages(operation_id TEXT,state TEXT);
    CREATE TABLE questions(task_id TEXT,status TEXT,owner TEXT,kind TEXT,data TEXT);
    -- A reduced pre-v23 database still has to take every later migration, so any table a
    -- later version references is created here. Omitting one makes the chain abort part way,
    -- which is how this fixture caught the missing wake_intents table.
    CREATE TABLE wake_intents(id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, node_id TEXT, kind TEXT,
      dedupe_key TEXT, data TEXT, state TEXT, consumed_operation_id TEXT, created_at INTEGER,
      UNIQUE(task_id,node_id,kind,dedupe_key));
    CREATE TABLE context_handoffs(id TEXT PRIMARY KEY, task_id TEXT, operation_id TEXT, version INTEGER,
      purpose TEXT, summary TEXT, package TEXT, digest TEXT, created_at INTEGER);
    CREATE TABLE budget_scopes(id TEXT PRIMARY KEY, task_id TEXT, owner_instance_id TEXT,
      limit_tokens INTEGER, unlimited INTEGER, used_tokens INTEGER, created_at INTEGER);
    CREATE TABLE agent_context_bindings(id TEXT PRIMARY KEY);
    CREATE TABLE context_resolutions(id TEXT PRIMARY KEY);
    INSERT INTO tasks(id) VALUES('task');
    INSERT INTO context_handoffs VALUES
      ('h1','task',NULL,1,'implement','first','{}','a',10),
      ('h2','task',NULL,1,'review','second','{}','b',10),
      ('h3','task',NULL,1,'verify','third','{}','c',11);
    PRAGMA user_version=22;
  `);
  raw.close();
  const store = new TaskStore(dbPath);
  try {
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
    expect(store.db.prepare('SELECT id,version FROM context_handoffs ORDER BY version').all())
      .toEqual([{ id: 'h1', version: 1 }, { id: 'h2', version: 2 }, { id: 'h3', version: 3 }]);
  } finally {
    store.close();
  }
});

test('v41 drafts and confirmation provenance survive migration and reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-upgrade-draft-v41-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'tasks.sqlite');
  const original = new TaskStore(dbPath);
  original.db.exec(`
    INSERT INTO projects(id,root,grants) VALUES('p','/legacy/project','[]');
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
    PRAGMA user_version=41;
  `);
  original.close();

  // Open twice: the first startup upgrades, the second must accept the schema it wrote.
  for (let open = 0; open < 2; open += 1) {
    const upgraded = new TaskStore(dbPath);
    try {
      expect(upgraded.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: SCHEMA_VERSION });
      expect(upgraded.db.prepare('SELECT * FROM proposals').all()).toEqual([{
        task_id: 'anchor', version: 1, requirement_version: 1,
        spec: '{"summary":"Original draft"}', decision_snapshot: 'Keep existing behavior',
        draft_revision: 1, draft_digest: null, archived_at: null, deleted_at: null,
      }]);
      expect(upgraded.db.prepare('SELECT * FROM conversation_acceptances').all()).toEqual([{
        conversation_id: 'c', proposal_version: 1, task_id: 'feature', target_branch: 'main',
        accepted_at: 123, draft_revision: null,
      }]);
    } finally { upgraded.close(); }
  }
});
