/**
 * A worker lane holds no store, so it leaves its tool calls in a file and the daemon folds those
 * lines in when somebody reads the numbers. The fold is the whole feature: a duplicated row
 * doubles every count, and a lost row loses a turn. So this drives the real daemon and reads the
 * real HTTP endpoint - a fold that only the unit knows about is a fold nobody can rely on.
 *
 * The file is the lane's side of the boundary, so it is laid down here in the documented format.
 * The daemon's own half - reading the file, remembering how far it got, folding it once - is the
 * half under test.
 */
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { startGraphDaemon } from '../../src/server/start.ts';

const cleanup: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const action of cleanup.reverse()) {
    await Promise.race([Promise.resolve(action()).catch(() => undefined), new Promise(resolve => setTimeout(resolve, 8_000))]);
  }
  cleanup.length = 0;
});

interface SpooledCall {
  tool: string;
  ms: number;
  isError: boolean;
  target?: string;
}

/** One spool record as a lane writes it: the instance it belongs to, the tool, the duration. */
function line(instanceId: string, call: SpooledCall): string {
  return `${JSON.stringify({
    instanceId,
    tool: call.tool,
    ms: Math.max(0, Math.round(call.ms)),
    isError: call.isError,
    at: Date.now(),
    ...(call.target ? { target: call.target } : {}),
  })}\n`;
}

/** Lay a lane's spool down where the daemon reads it from. */
async function layDownSpool(directory: string, instanceId: string, calls: SpooledCall[]): Promise<string> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${instanceId}.jsonl`);
  await writeFile(file, calls.map(call => line(instanceId, call)).join(''));
  return file;
}

/** A daemon with nothing configured, so the only thing it can report is what the lanes left. */
async function daemon() {
  const root = await mkdtemp(join(tmpdir(), 'graph-tool-spool-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const webDir = join(root, 'web');
  await mkdir(webDir);
  await writeFile(join(webDir, 'index.html'), '<!doctype html><div>Graph</div>');
  const server = await startGraphDaemon({
    configPath: null, stateDir: join(root, 'state'), webDir, port: 0, mode: 'view', env: {}, log: () => undefined,
  });
  cleanup.push(() => server.close());
  const home = await fetch(server.url, { headers: { origin: server.url } });
  const headers = { origin: server.url, cookie: home.headers.get('set-cookie') ?? '' };
  return { server, headers };
}

interface ToolStat {
  tool: string;
  role: string | null;
  calls: number;
  errors: number;
  totalMs: number;
}

/** Read the numbers the way the console does: one HTTP request, one snapshot. */
async function readStats(server: { url: string }, headers: Record<string, string>): Promise<ToolStat[]> {
  const response = await fetch(`${server.url}/api/tool-stats`, { headers });
  expect(response.status).toBe(200);
  const body = await response.json() as { stats: ToolStat[] };
  return body.stats;
}

test('a lane\'s spooled calls reach the numbers the console reads, exactly once', async () => {
  const { server, headers } = await daemon();
  await layDownSpool(join(server.stateDir, 'tool-calls'), 'lane-one', [
    { tool: 'bash', ms: 40, isError: false },
    { tool: 'edit', ms: 90, isError: true },
  ]);

  const stats = await readStats(server, headers);
  expect(stats.find(entry => entry.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, totalMs: 40 });
  expect(stats.find(entry => entry.tool === 'edit')).toMatchObject({ calls: 1, errors: 1, totalMs: 90 });

  // Reading again must not count the same line twice: the daemon remembers how far it got.
  const again = await readStats(server, headers);
  expect(again.find(entry => entry.tool === 'bash')).toMatchObject({ calls: 1, errors: 0, totalMs: 40 });
  expect(again.find(entry => entry.tool === 'edit')).toMatchObject({ calls: 1, errors: 1, totalMs: 90 });
  expect(again.reduce((sum, entry) => sum + entry.calls, 0)).toBe(2);
}, 60_000);

test('a lane that was handed its own instance directory is read from there too', async () => {
  const { server, headers } = await daemon();
  // A lane receives its session directory as its state dir, so its spool lands one level deeper.
  await layDownSpool(join(server.stateDir, 'instances', 'lane-two', 'tool-calls'), 'lane-two', [
    { tool: 'read', ms: 30, isError: false, target: '/p/.agents/skills/heartbeat/SKILL.md' },
  ]);

  const stats = await readStats(server, headers);
  expect(stats.find(entry => entry.tool === 'read')).toMatchObject({ calls: 1, errors: 0, totalMs: 30 });

  // One convention, one offset: the instance file is not counted again on the next read either.
  const again = await readStats(server, headers);
  expect(again.find(entry => entry.tool === 'read')).toMatchObject({ calls: 1, totalMs: 30 });
}, 60_000);

test('a half-written last line waits for the rest of it instead of counting a broken row', async () => {
  const { server, headers } = await daemon();
  const directory = join(server.stateDir, 'tool-calls');
  const file = await layDownSpool(directory, 'lane-three', [{ tool: 'read', ms: 10, isError: false }]);
  // A lane appends while the daemon reads, so the last line is often half written.
  await appendFile(file, '{"instanceId":"lane-three","tool":"rea');

  // The complete line is folded in; the half-written one waits for the rest of it.
  const partial = await readStats(server, headers);
  expect(partial.find(entry => entry.tool === 'read')).toMatchObject({ calls: 1, errors: 0, totalMs: 10 });

  await appendFile(file, `d","ms":20,"isError":false,"at":${Date.now()}}\n`);
  const stats = await readStats(server, headers);
  expect(stats.find(entry => entry.tool === 'read')).toMatchObject({ calls: 2, errors: 0, totalMs: 30 });
}, 60_000);

test('clearing the sample removes the spool, so nothing is read back in', async () => {
  const { server, headers } = await daemon();
  await layDownSpool(join(server.stateDir, 'tool-calls'), 'lane-four', [{ tool: 'bash', ms: 5, isError: false }]);
  expect(await readStats(server, headers)).toHaveLength(1);

  const cleared = await fetch(`${server.url}/api/tool-stats/clear`, { method: 'POST', headers });
  expect(cleared.status).toBe(200);

  // The console's clear button means the sample is gone. If the spool survived it, the next read
  // would quietly resurrect the calls the user just deleted.
  expect(await readStats(server, headers)).toEqual([]);
}, 60_000);
