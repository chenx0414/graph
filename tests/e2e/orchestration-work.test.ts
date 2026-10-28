import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
});

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`Expected an object: ${JSON.stringify(value)}`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(value: unknown, key: string): string {
  const result = record(value)[key];
  if (typeof result !== 'string' || result === '') throw new Error(`Expected ${key}: ${JSON.stringify(value)}`);
  return result;
}

test('independent work survives revisions, concurrent edits, idempotent retries and a daemon restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-orchestration-work-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }] }));
  const start = async () => {
    const daemon = await launchCli(root, { configPath });
    cleanup.push(() => daemon.close());
    return daemon;
  };
  let daemon = await start();
  async function request(path: string, body?: object) {
    const response = await daemon.request(path, body === undefined ? {} : {
      method: 'POST', body: JSON.stringify(body),
    });
    const data: unknown = await response.json();
    return { status: response.status, data };
  }
  async function ok(path: string, body?: object) {
    const result = await request(path, body);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return record(result.data);
  }

  const global = stringField(await ok('/api/orchestration/global', { requestId: 'open-global' }), 'conversationId');
  const project = stringField(await ok('/api/projects/p/thread', { requestId: 'open-project' }), 'conversationId');
  const messageA = stringField(await ok(`/api/conversations/${global}/messages`, {
    requestId: 'message-a', text: 'Create a search feature.',
  }), 'messageId');
  const messageB = stringField(await ok(`/api/conversations/${global}/messages`, {
    requestId: 'message-b', text: 'Create an export feature.',
  }), 'messageId');
  const foreign = stringField(await ok(`/api/conversations/${project}/messages`, {
    requestId: 'foreign-message', text: 'I am a message in the project conversation.',
  }), 'messageId');

  const unassignedMessage = stringField(await ok(`/api/conversations/${global}/messages`, {
    requestId: 'unassigned-message', text: 'I have an idea but have not picked a project.',
  }), 'messageId');
  const unassigned = await ok('/api/orchestration/work', {
    requestId: 'unassigned-work', conversationId: global, sourceMessageId: unassignedMessage,
    brief: 'Explore the idea', acceptance: [],
  });
  const unassignedId = stringField(unassigned, 'id');
  expect(unassigned).toMatchObject({ projectId: null, revision: 1, state: 'clarifying' });
  const assigned = await ok(`/api/orchestration/work/${unassignedId}/revise`, {
    requestId: 'assign-project', expectedRevision: 1, projectId: 'p',
    brief: 'Explore the idea in project p', acceptance: ['Document the result'],
  });
  expect(assigned).toMatchObject({ projectId: 'p', revision: 2, revisions: [
    expect.objectContaining({ revision: 1, projectId: null }),
    expect.objectContaining({ revision: 2, projectId: 'p' }),
  ] });

  const inputA = {
    requestId: 'work-a', conversationId: global, projectId: 'p', sourceMessageId: messageA,
    brief: 'Search records', acceptance: ['Search results are visible'],
  };
  const inputB = {
    requestId: 'work-b', conversationId: global, projectId: 'p', sourceMessageId: messageB,
    brief: 'Export records', acceptance: ['Download an export'],
  };
  const a = await ok('/api/orchestration/work', inputA);
  const b = await ok('/api/orchestration/work', inputB);
  const aId = stringField(a, 'id');
  const bId = stringField(b, 'id');
  expect(aId).not.toBe(bId);
  expect(a).toMatchObject({
    id: aId, projectId: 'p', conversationId: global, sourceMessageId: messageA,
    revision: 1, brief: 'Search records', acceptance: ['Search results are visible'],
    state: 'clarifying', executionPaused: false,
  });
  expect(b).toMatchObject({ revision: 1, brief: 'Export records', state: 'clarifying' });
  expect(await ok('/api/orchestration/work', inputA)).toEqual(a);
  const conflict = await request('/api/orchestration/work', { ...inputA, brief: 'Changed under the same request ID' });
  expect([400, 409]).toContain(conflict.status);
  const forged = await request('/api/orchestration/work', {
    ...inputA, requestId: 'forged-source', sourceMessageId: foreign,
  });
  expect([400, 403, 409]).toContain(forged.status);

  const fractional = await request(`/api/orchestration/work/${aId}/revise`, {
    requestId: 'fractional', expectedRevision: 1.9, brief: 'Bad revision', acceptance: ['Must reject'],
  });
  expect([400, 409]).toContain(fractional.status);
  expect((await ok(`/api/orchestration/work/${aId}`)).revision).toBe(1);

  const revision = {
    requestId: 'revise-a', expectedRevision: 1,
    brief: 'Search records by title', acceptance: ['Search by title shows results'],
  };
  const changed = await ok(`/api/orchestration/work/${aId}/revise`, revision);
  expect(changed).toMatchObject({
    id: aId, revision: 2, brief: 'Search records by title', acceptance: ['Search by title shows results'],
  });
  expect(await ok(`/api/orchestration/work/${aId}/revise`, revision)).toEqual(changed);
  const stale = await request(`/api/orchestration/work/${aId}/revise`, {
    requestId: 'stale-revision', expectedRevision: 1, brief: 'Stale edit', acceptance: ['Wrong'],
  });
  expect([400, 409]).toContain(stale.status);
  expect(await ok(`/api/orchestration/work/${bId}`)).toMatchObject({
    id: bId, revision: 1, brief: 'Export records', acceptance: ['Download an export'],
  });

  const list = await ok('/api/orchestration/work?projectId=p');
  expect(list.items).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: aId, revision: 2, revisions: expect.arrayContaining([
      expect.objectContaining({ revision: 1, brief: 'Search records' }),
      expect.objectContaining({ revision: 2, brief: 'Search records by title' }),
    ]) }),
    expect.objectContaining({ id: bId, revision: 1, revisions: expect.arrayContaining([
      expect.objectContaining({ revision: 1, brief: 'Export records' }),
    ]) }),
  ]));

  const raced = await Promise.all([
    request(`/api/orchestration/work/${aId}/revise`, {
      requestId: 'race-one', expectedRevision: 2, brief: 'Search one', acceptance: ['Results one'],
    }),
    request(`/api/orchestration/work/${aId}/revise`, {
      requestId: 'race-two', expectedRevision: 2, brief: 'Search two', acceptance: ['Results two'],
    }),
  ]);
  expect(raced.filter(result => result.status === 200)).toHaveLength(1);
  expect(raced.filter(result => [400, 409].includes(result.status))).toHaveLength(1);
  const afterRace = await ok(`/api/orchestration/work/${aId}`);
  expect(afterRace.revision).toBe(3);
  expect(await ok('/api/orchestration/work', inputA)).toEqual(a);
  expect(await ok(`/api/orchestration/work/${aId}/revise`, revision)).toEqual(changed);
  expect(['Search one', 'Search two']).toContain(afterRace.brief);

  await daemon.close();
  daemon = await start();
  expect(await ok(`/api/orchestration/work/${aId}`)).toEqual(afterRace);
  expect(await ok(`/api/orchestration/work/${bId}`)).toMatchObject({
    id: bId, revision: 1, brief: 'Export records', acceptance: ['Download an export'],
  });
}, 60_000);
