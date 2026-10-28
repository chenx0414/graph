import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { PROPOSAL } from './go-graph-confirmation.fixture.ts';

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

function text(value: unknown, key: string): string {
  const item = record(value)[key];
  if (typeof item !== 'string' || item === '') throw new Error(`Expected ${key}: ${JSON.stringify(value)}`);
  return item;
}

test('two works keep independent drafts, revisions, archival and receipts through a daemon restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-work-drafts-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'project'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root"></div>');
  const configPath = join(root, 'graph.config.json');
  await writeFile(configPath, JSON.stringify({ version: 1, projects: [{ id: 'p', root: join(root, 'project') }] }));
  const start = async () => {
    const daemon = await launchCli(root, { configPath });
    cleanup.push(() => daemon.close());
    return daemon;
  };
  let daemon = await start();
  async function request(path: string, body?: object) {
    const response = await daemon.request(path, body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) });
    const data: unknown = await response.json();
    return { status: response.status, data };
  }
  async function ok(path: string, body?: object) {
    const result = await request(path, body);
    expect(result.status, JSON.stringify(result.data)).toBe(200);
    return record(result.data);
  }
  const global = text(await ok('/api/orchestration/global', { requestId: 'global' }), 'conversationId');
  const message = async (id: string) => text(await ok(`/api/conversations/${global}/messages`, {
    requestId: `message-${id}`, text: `Build ${id}`,
  }), 'messageId');
  const createWork = async (id: string) => text(await ok('/api/orchestration/work', {
    requestId: `work-${id}`, conversationId: global, projectId: 'p', sourceMessageId: await message(id),
    brief: `Build ${id}`, acceptance: [`${id} works`],
  }), 'id');
  const a = await createWork('search');
  const b = await createWork('export');
  const pathA = `/api/orchestration/work/${a}/drafts`;
  const pathB = `/api/orchestration/work/${b}/drafts`;
  const firstA = { requestId: 'draft-a', workRevision: 1, proposal: PROPOSAL };
  const firstB = { requestId: 'draft-b', workRevision: 1, proposal: { ...PROPOSAL, summary: 'Export graph' } };
  const draftA = await ok(pathA, firstA);
  const draftB = await ok(pathB, firstB);
  expect(draftA).toMatchObject({ workId: a, version: 1, workRevision: 1, draftRevision: 1, stale: false });
  expect(draftB).toMatchObject({ workId: b, version: 1, workRevision: 1, draftRevision: 1, stale: false });
  const edit = { requestId: 'edit-a', workRevision: 1, expectedDraftRevision: 1,
    proposal: { ...PROPOSAL, summary: 'Edited search graph' } };
  const updated = await ok(pathA, edit);
  expect(updated).toMatchObject({ version: 1, draftRevision: 2, proposal: { summary: 'Edited search graph' } });
  expect(await ok(`${pathB}/1`)).toEqual(draftB);
  expect((await request(pathA, { ...edit, requestId: 'stale' })).status).not.toBe(200);
  expect((await request(pathA, { ...edit, requestId: 'fraction', expectedDraftRevision: 1.5 })).status).not.toBe(200);
  expect((await request(pathA, { ...edit, proposal: { ...PROPOSAL, summary: 'Different' } })).status).not.toBe(200);
  expect(await ok(pathA, firstA)).toEqual(draftA);
  expect(await ok(pathA, edit)).toEqual(updated);

  await ok(`/api/orchestration/work/${a}/revise`, {
    requestId: 'revise-work-a', expectedRevision: 1, brief: 'Narrow search', acceptance: ['New criterion'],
  });
  expect(await ok(`${pathA}/1`)).toMatchObject({ stale: true, workRevision: 1 });
  expect(await ok(`${pathB}/1`)).toEqual(draftB);
  const draftA2 = await ok(pathA, { requestId: 'draft-a-revised', workRevision: 2,
    proposal: { ...PROPOSAL, requirementVersion: 2, summary: 'New search scope' } });
  expect(draftA2).toMatchObject({ version: 2, draftRevision: 1, workRevision: 2, stale: false });

  const archived = await ok(`${pathB}/1/archive`, { requestId: 'archive-b', expectedDraftRevision: 1 });
  expect(archived).toMatchObject({ archived: true, draftRevision: 2 });
  expect((await ok(pathB)).items).toEqual([]);
  expect((await ok(`${pathB}?archived=true`)).items).toEqual([archived]);
  const restored = await ok(`${pathB}/1/restore`, { requestId: 'restore-b', expectedDraftRevision: 2 });
  expect(restored).toMatchObject({ archived: false, draftRevision: 3 });
  expect((await request(`${pathB}/1/delete`, { requestId: 'delete-stale', expectedDraftRevision: 2 })).status).not.toBe(200);

  await daemon.close();
  daemon = await start();
  expect(await ok(`${pathA}/2`)).toEqual(draftA2);
  expect(await ok(`${pathB}/1`)).toEqual(restored);
  expect(await ok(pathA, edit)).toEqual(updated);
}, 60_000);
