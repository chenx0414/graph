import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

// A goal is work, and work belongs in a graph: the objective becomes the graph's task,
// the person's acceptance criteria become its specification, and the team that plans,
// implements and reviews it on two independent axes is the one the product already has.
// The conversation keeps the objective and the state - no in-chat working turn, no
// acceptance talk in the same window.

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

const SKILLS = [
  'mattpocock-skills-skills-engineering-codebase-design',
  'mattpocock-skills-skills-engineering-tdd',
  'mattpocock-skills-skills-engineering-code-review',
];

test('a goal in a project conversation becomes the planning, working and reviewing graph', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-goal-graph-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(project, { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  // The team assembly requires its skills to be installed. They are on this machine;
  // the daemon under test gets its own copy instead of reading the live home.
  const skills = join(root, 'graph-home', 'capabilities', 'skills');
  await mkdir(skills, { recursive: true });
  for (const skill of SKILLS) {
    await cp(join(homedir(), '.graph', 'capabilities', 'skills', skill), join(skills, skill), { recursive: true });
  }
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({
    version: 1,
    projects: [{ id: 'p', root: project }],
  }));
  const daemon = await launchCli(root, { configPath, graphHome: join(root, 'graph-home') });
  cleanup.push(() => daemon.close());
  const request = async (path: string, body?: object) => {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, any> };
  };

  const created = await request('/api/conversations', { projectId: 'p', text: '准备开始', requestId: 'goal-graph-conversation' });
  const createdText = JSON.stringify(created.body);
  expect(created.status, createdText).toBe(200);
  const conversationId = String(created.body.conversationId);

  const set = await request(`/api/conversations/${conversationId}/messages`, {
    text: '/goal 把导出做成 CSV\n验收：\n1) POST /api/export 返回 CSV\n2) 有一条 E2E 覆盖导出',
    requestId: 'goal-graph-set',
  });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
  const goal = set.body.goal as Record<string, any>;
  // The goal carries its criteria and the graph that runs it.
  expect(goal.objective).toBe('把导出做成 CSV');
  expect(goal.acceptance).toContain('POST /api/export 返回 CSV');
  expect(String(goal.graphId ?? ''), JSON.stringify(set.body)).not.toBe('');
  // No in-chat turn: the graph does the work.
  expect(set.body.started).toBeUndefined();
  const line = ((await request(`/api/conversations/${conversationId}`)).body.messages as { kind?: string; text?: string }[])
    .filter(message => message.kind === 'goal').map(message => message.text ?? '').join('\n');
  expect(line).toContain('目标已开图执行');

  // The graph is the team: a planner, a worker, and two independent reviewers.
  // The graph is not just created: the objective is delivered into its job input, so
  // the planner has work instead of waiting for an input nobody sends. The delivery is
  // the durable record of that, and it exists whether or not a model is reachable.
  const { execFileSync } = await import('node:child_process');
  const dbPath = join(root, 'state', 'tasks.sqlite');
  await expect.poll(() => {
    const rows = execFileSync('sqlite3', [dbPath, `SELECT COUNT(*) FROM kernel_deliveries WHERE task_id='${goal.graphId}' AND to_endpoint='planner.job' AND value LIKE '%把导出做成 CSV%'`]).toString().trim();
    return Number(rows);
  }, { timeout: 30_000, interval: 500 }).toBeGreaterThan(0);

  // And the global supervisor is woken once, with the graph named, so the work has an
  // owner who is watching it rather than a graph nobody follows.
  await expect.poll(async () => {
    const conversations = (await request('/api/conversations')).body as { id: string; role?: string }[];
    const global = conversations.find(conversation => conversation.role === 'global');
    if (!global) return '';
    const view = (await request(`/api/conversations/${global.id}`)).body as { messages?: { kind?: string; text?: string }[] };
    return (view.messages ?? []).map(message => message.text ?? '').join('\n');
  }, { timeout: 30_000, interval: 500 }).toContain('目标已开图');

  const task = (await request(`/api/tasks/${goal.graphId}`)).body as { nodes?: { id: string; definitionVersion?: string }[] };
  // Each node is bound to the recipe the team assembly compiled: the planner, the
  // worker and both independent reviewers.
  const bindings = Object.fromEntries((task.nodes ?? []).map(node => [node.id, node.definitionVersion ?? '']));
  expect(bindings.planner).toContain('matt-team-planner');
  expect(bindings.worker).toContain('matt-team-worker');
  expect(bindings.standards).toContain('matt-team-standards');
  expect(bindings.spec).toContain('matt-team-spec');

  // The graph's completion is the goal's completion: finishing the work in the graph
  // closes the goal, and the conversation never runs an acceptance turn of its own.
  execFileSync('sqlite3', [dbPath, `UPDATE tasks SET phase='completed' WHERE id='${goal.graphId}'`]);
  const after = await request(`/api/conversations/${conversationId}/goal`);
  expect((after.body.goal as Record<string, any>).status).toBe('completed');
}, 120_000);
