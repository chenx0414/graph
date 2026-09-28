import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { openGraphServer } from '../../src/server/host.ts';
import { openAgentContextLibrary } from '../../src/runtime/agent-context.ts';
import { openaiServer } from '../fixtures/openai-server.ts';
import { fullAccessPolicy } from '../../src/core/access-policy.ts';
import { insertQuestion } from '../../src/core/question-routing.ts';
import { pendingWakes } from '../../src/core/wake-ledger.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});

/**
 * The whole path of "main reviews a human acceptance check first", on a real server and a
 * real model request: a check opens, the master is woken with that exact reason, its sent
 * turn carries the review tools and the reason, and the person's acceptance is still
 * required afterwards.
 *
 * This is also the end-to-end evidence item 1 owed: the wake has to reach a real turn's
 * briefing rather than only the wake table.
 */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'graph-prereview-e2e-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  await mkdir(workspace, { recursive: true });
  await writeFile(join(workspace, 'README.md'), 'WORKSPACE\n');
  const provider = await openaiServer([{ text: 'reviewed' }, { text: 'reviewed again' }]);
  cleanup.push(() => provider.close());
  const library = openAgentContextLibrary(join(root, 'prompts'));
  const server = await openGraphServer({
    stateDir: join(root, 'state'), agentContext: library, catalog: { capabilityRoot: join(root, 'capabilities') },
    projects: [{ id: 'project', root: workspace }], access: () => fullAccessPolicy(),
    systemContext: {},
    models: {
      entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }],
      credentialFor: () => ({ credentialId: 'local', apiKey: 'scripted-local-key' }), modelRuntime: provider.runtime,
    },
    master: { action: 'master', definitionVersion: () => 'main@1', model: 'local' },
  });
  cleanup.push(() => server.close());
  // The daemon's own database file. Reading it here is deliberate: the assertions are on
  // what a real daemon wrote, not on an object only this test can reach.
  const store = new TaskStore(join(root, 'state', 'tasks.sqlite'));
  cleanup.push(async () => store.close());
  return { server, provider, store, root };
}

type Db = { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => unknown } };

test('a human acceptance check wakes the master, whose own turn carries the review tools', async () => {
  const { server, provider, store } = await fixture();
  const runtime = server.runtime;
  const db = store.db as unknown as Db;

  const created = await runtime.conversations.create({ projectId: 'project', text: 'ship it', requestId: 'create' });
  const conversationId = created.conversationId;
  const anchor = (db.prepare('SELECT anchor_task_id FROM conversations WHERE id=?').get(conversationId) as { anchor_task_id: string }).anchor_task_id;
  // The master must be wakeable at all, or this tests nothing.
  db.prepare("UPDATE nodes SET status='succeeded' WHERE task_id=? AND id='master'").run(anchor);

  // A conversation starts with only its anchor and master. The graph task and its
  // acceptance node are added here, in the same shape a confirmed graph produces, so the
  // fact under test is real rather than a stand-in for it.
  const graphTask = 'graph-task';
  store.transaction(() => {
    store.db.prepare("INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id) VALUES(?,?,?,?,?,?)")
      .run(graphTask, 'project', 'ship it', 9, 'running', conversationId);
    // The anchor/master already arrives with its instance from the real create call;
    // give it room to run rather than inserting a second one.
    store.db.prepare("UPDATE instances SET budget=100000, unlimited=1, used=0 WHERE task_id=? AND node_id='master'").run(anchor);
    // The acceptance check node sits blocked, waiting for the person, as production does.
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,activation_id,status) VALUES(?,?,?,?,?)")
      .run(graphTask, 'accept', JSON.stringify({ kind: 'program', action: 'graph.human_check' }), 'h', 'blocked');
  });

  const before = provider.requests.length;
  // The check opens: this is the single fact under test.
  const check = insertQuestion(store, {
    taskId: graphTask,
    nodeId: 'accept',
    kind: 'human_check',
    data: { prompt: 'A human acceptance check is required', activationId: 'h', commitSha: null },
  });
  expect(pendingWakes(store, anchor, 'master').map(wake => wake.kind)).toEqual(['human_check']);

  // The master takes its real turn.
  await runtime.host.runReady();
  expect(provider.requests.length).toBeGreaterThan(before);
  const sent = provider.requests.at(-1) as unknown as {
    tools: { function: { name: string } }[];
    messages: { role: string; content: unknown }[];
  };
  const names = sent.tools.map(tool => tool.function.name);
  // The turn is offered the review tools, and it is told why it is awake.
  expect(names).toContain('list_human_checks');
  expect(names).toContain('review_human_check');
  // A user message can be a plain string or a list of content parts (attachments make it a
  // list), so flatten both rather than assuming one - asserting on String(content) printed
  // "[object Object]" and looked like a missing briefing when the briefing was right there.
  const briefing = sent.messages.map(message => textOf(message.content)).join('\n');
  expect(briefing).toContain('You were woken by the harness');
  expect(briefing).toContain('human acceptance check');

  // Reviewing is not accepting: the check is still open, and still the user's to answer.
  expect(humanCheckRow(db, check.id)).toMatchObject({ owner: 'user', status: 'open' });
  // Nothing was auto-approved on the master's behalf.
  expect(db.prepare("SELECT COUNT(*) AS count FROM events WHERE type='human.accepted'").get()).toEqual({ count: 0 });
});

/** A message content that is either text or a list of content parts, as one string. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part => textOf((part as { text?: unknown })?.text ?? '')).join('');
  return '';
}

function humanCheckRow(db: Db, id: string) {
  return db.prepare('SELECT owner,status FROM questions WHERE id=?').get(id) as { owner: string; status: string };
}
