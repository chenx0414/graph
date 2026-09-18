import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { installPresets } from '../../src/catalog/presets.ts';
import { startGraphDaemon } from '../../src/server/start.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

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
      preparation: store.db.prepare("SELECT state,repo_root,baseline_sha FROM project_preparation WHERE project_id='legacy'").get() as { state: string; repo_root: string; baseline_sha: string } | undefined,
      newNodes: store.db.prepare("SELECT COUNT(*) AS count FROM node_entries WHERE task_id<>'legacy-task'").get() as { count: number },
    };
  } finally { store.close(); }
}

for (const fixture of ['v13', 'v17'] as const) {
  test(`a real ${fixture} state directory upgrades in place and runs the full chain (C03)`, async () => {
    const provider = await openaiServer([{ text: 'legacy upgrade worker finished' }]);
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
        // The unfinished legacy task still references its historical model; the
        // live config must keep binding it or the save is correctly rejected.
        { id: 'legacy-model', provider: 'graph-openai', grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' },
        ...(extraModel ? [{ id: 'local-2', provider: 'graph-openai', grade: 'medium', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256, credentialId: 'local' }] : []),
      ] },
      credentials: { local: { secretRef: 'GRAPH_LOCAL_KEY' } },
    });
    await writeFile(configPath, JSON.stringify(document(0, false), null, 2));

    // Phase A: daemon opens the legacy database, serves the legacy task view
    // and applies a hot configuration change on the same file.
    const daemon = await startGraphDaemon({ configPath, stateDir, webDir: web, port: 0, mode: 'execute', dynamic: true, env: { GRAPH_LOCAL_KEY: 'synthetic' }, log: () => undefined });
    const home = await fetch(daemon.url, { headers: { origin: daemon.url } });
    const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
    const taskView = await fetch(`${daemon.url}/api/tasks/legacy-task`, { headers });
    expect(taskView.status).toBe(200);
    const view = await taskView.json() as { id: string; nodes?: unknown[] };
    expect(view.id).toBe('legacy-task');
    const configBefore = await (await fetch(`${daemon.url}/api/config`, { headers })).json() as { revision: number };
    const saveResponse = await fetch(`${daemon.url}/api/config`, { method: 'POST', headers, body: JSON.stringify({ expectedRevision: configBefore.revision, document: document(configBefore.revision, true) }) });
    expect(saveResponse.status).toBe(200);
    const applied = await saveResponse.json() as { applied: boolean; restartRequired: boolean; revision: number };
    expect(applied).toMatchObject({ applied: true, restartRequired: false });
    const configAfter = await (await fetch(`${daemon.url}/api/config`, { headers })).json() as { revision: number; config: { models: { entries: { id: string }[] } } };
    expect(configAfter.revision).toBeGreaterThan(configBefore.revision);
    expect(configAfter.config.models.entries.map(entry => entry.id)).toContain('local-2');
    await daemon.close();

    const upgraded = await inspect(dbPath);
    expect(upgraded.version).toBe(26);
    expect(upgraded.instance).toMatchObject({ budget: 20_000_000, used: 12_345, unlimited: 0, models_used: '["legacy-model"]' });
    expect(JSON.parse(upgraded.cost.cost)).toEqual({ amount: 0.001, currency: 'USD' });
    expect(upgraded.pauseColumns.sort()).toEqual(['pause_ms', 'pause_since', 'user_wait_ms', 'user_wait_since']);
    expect(upgraded.conversationColumns).toEqual(expect.arrayContaining(['archived_at', 'thinking_level']));
    expect(upgraded.bindingColumns).toEqual(expect.arrayContaining(['model_policy_digest', 'tool_policy_digest']));
    expect(upgraded.resolutionColumns).toEqual(expect.arrayContaining(['constraints_digest', 'review_policy', 'predecessor_policy']));
    expect(upgraded.scopeColumns).toContain('root_task_id');
    expect(upgraded.resultHandoffColumns).toEqual(expect.arrayContaining([
      'operation_id', 'activation_id', 'output_version', 'schema_kind', 'body', 'digest',
    ]));
    expect(upgraded.questionColumns).toContain('owner');

    // Phase B: the same file runs a scripted worker through Git preparation.
    const runtime = await openTaskRuntime({
      stateDir, projects: [{ id: 'legacy', root: projectRoot }],
      actions: { check: { kind: 'program' as const, prepare: async () => async () => ({ outcome: 'completed' as const, output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(projectRoot, 'ok.txt'), digest: 'a'.repeat(64) } }] }) } },
      models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'synthetic', modelRuntime: provider.runtime },
      limits: { defaultBudgetTokens: 20_000_000 },
    });
    cleanup.push(() => runtime.close());
    await installPresets(runtime.catalog, presetsRoot);
    const { taskId } = await runtime.user.begin({ projectId: 'legacy', request: 'Upgrade chain worker', requestId: 'upgrade-begin' });
    await runtime.supervisor(taskId).propose({
      requirementVersion: 1, summary: 'Upgrade chain',
      acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
      nodes: [
        { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
        { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
      ],
    }, 'upgrade-propose');
    await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'upgrade-accept' });
    await runtime.host.runReady();
    const after = await inspect(dbPath);
    expect(after.preparation?.state).toBe('ready');
    expect(after.preparation?.baseline_sha).toMatch(/^[0-9a-f]{40}$/);
    expect(after.newNodes.count).toBeGreaterThan(0);
    // Same file throughout: no delete-and-recreate migration.
    expect((await stat(dbPath)).ino).toBe(inodeBefore);
    expect(upgraded.instance.budget).toBe(20_000_000);
  }, 120_000);
}

test('v23 renumbers legacy handoffs before enforcing one version per task', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-upgrade-v22-handoffs-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const dbPath = join(root, 'tasks.sqlite');
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE tasks(id TEXT PRIMARY KEY);
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
    expect((store.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(26);
    expect(store.db.prepare('SELECT id,version FROM context_handoffs ORDER BY version').all())
      .toEqual([{ id: 'h1', version: 1 }, { id: 'h2', version: 2 }, { id: 'h3', version: 3 }]);
  } finally {
    store.close();
  }
});
