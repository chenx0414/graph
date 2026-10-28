import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { launchCli } from '../helpers/cli-daemon.ts';
import { PROPOSAL } from './go-graph-confirmation.fixture.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.reverse()) await close(); cleanup.length = 0; });
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected object: ${JSON.stringify(value)}`);
  return Object.fromEntries(Object.entries(value));
}
function text(value: unknown, key: string): string {
  const item = record(value)[key];
  if (typeof item !== 'string' || !item) throw new Error(`Expected ${key}: ${JSON.stringify(value)}`);
  return item;
}

test('confirmed work drafts create independent persistent graphs with stable retry keys', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-work-confirm-'));
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
  await ok('/api/projects/p/thread', { requestId: 'project' });
  async function work(id: string) {
    const source = text(await ok(`/api/conversations/${global}/messages`, { requestId: `message-${id}`, text: `Build ${id}` }), 'messageId');
    const item = await ok('/api/orchestration/work', { requestId: `work-${id}`, conversationId: global, projectId: 'p', sourceMessageId: source, brief: `Build ${id}`, acceptance: [`${id} works`] });
    const workID = text(item, 'id');
    await ok(`/api/orchestration/work/${workID}/drafts`, { requestId: `draft-${id}`, workRevision: 1, proposal: { ...PROPOSAL, summary: `Plan ${id}` } });
    return workID;
  }
  const first = await work('first');
  const second = await work('second');
  const input = { workRevision: 1, version: 1, draftRevision: 1, graphKey: 'main' };
  const stale = await request(`/api/orchestration/work/${first}/confirm`, { ...input, draftRevision: 2, requestId: 'stale' });
  expect(stale.status).not.toBe(200);
  const parallel = await Promise.all(Array.from({ length: 4 }, (_, index) => ok(`/api/orchestration/work/${first}/confirm`, { ...input, requestId: `first-${index}` })));
  const graphID = text(parallel[0], 'graphId');
  for (const receipt of parallel) expect(receipt).toMatchObject({ workId: first, graphId: graphID, state: 'ready' });
  const conflict = await request(`/api/orchestration/work/${first}/confirm`, { ...input, version: 2, requestId: 'conflicting-key' });
  expect(conflict.status).not.toBe(200);
  const other = await ok(`/api/orchestration/work/${second}/confirm`, { ...input, requestId: 'second' });
  expect(text(other, 'graphId')).not.toBe(graphID);
  const graphList = await ok(`/api/orchestration/work/${first}/graphs`);
  expect(graphList.items).toEqual([expect.objectContaining({ graphId: graphID, graphKey: 'main', state: 'ready' })]);
  await daemon.close();
  daemon = await start();
  const replay = await ok(`/api/orchestration/work/${first}/confirm`, { ...input, requestId: 'first-after-restart' });
  expect(replay).toMatchObject({ graphId: graphID, state: 'ready' });
  expect((await ok(`/api/orchestration/work/${second}/graphs`)).items).toEqual([expect.objectContaining({ graphId: text(other, 'graphId') })]);
}, 60_000);
