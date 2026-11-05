/**
 * Crash recovery, end to end: a killed app comes back on the same conversation,
 * can say why it left, and the work it was watching never stopped.
 *
 * What this file proves:
 *
 *  - a2  SIGKILL of this test's own app -> the keeper restarts it and the window
 *        comes back to the same conversation; a normal quit -> no restart.
 *  - a3  after the restart `crash/last-crash.json` carries the real time and the
 *        real reason (keeper exit status, or a system `.ips`) - never "unknown".
 *  - a4  the daemon keeps running (same pid, port, `startedAt`) and the lane that
 *        was running finishes its work after the kill; the task is the same one.
 *  - a5  an isolated instance: own `GRAPH_APP_USER_DATA`, port and keeper. The
 *        user's app is snapshotted before and after and never signalled.
 *
 * How the machine is treated:
 *
 *  - one Electron instance at a time (slot lock in `…instance.ts`), at most 3
 *    start-up attempts 2s/4s apart, then an explicit "环境阻塞" failure - never
 *    an unbounded retry, never a skip;
 *  - `--max-restarts=0`, so one attempt is one launch (the keeper's own
 *    crash-loop retries would otherwise multiply the system dialogs);
 *  - the two instances this scenario needs are serial: the first is dead before
 *    the keeper starts the second;
 *  - the user's app is checked around every launch: pids 3329/3331 alive, and
 *    the daemon its console.json names (port 65146) the same process answering.
 *
 * The kill lands after the app has been up for the keeper's stable window, so the
 * restart is the "a working app came back" branch rather than the crash-loop cap.
 * The master drives the three lanes one after another (`graph_send` returns once
 * the module finished), so the lane that is running when the third one starts is
 * the work the kill is aimed at: that lane must survive the kill and finish.
 *
 * Artifacts (screenshots, markers, keeper log, lanes) go to a temp directory,
 * with a `summary.json` holding every asserted value. Run:
 *   node node_modules/vitest/vitest.mjs run tests/e2e/desktop-crash-recovery.test.ts
 */
import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import { expect, test } from 'vitest';
import { keeperDecision } from '../../desktop/crash.ts';
import { masterProvider } from './go-graph-modules.fixture.ts';
import {
  alive, connectWindow, freePort, instancePaths, isSandboxed, laneModule, laneTimelines, prepareInstance, readJsonSync,
  readLanes, sleep, userConsolePath, waitFor,
} from './desktop-crash-recovery.fixture.ts';
import {
  assertNotSandboxed, assertSameUserInstance, assertUserInstance, captureUserInstance, startIsolatedInstance,
  writeLaunchFailure, type StartedInstance,
} from './desktop-crash-recovery.instance.ts';

/** The keeper's stable window: a run that lived this long restarts without a cap. */
const STABLE_MS = 30_000;
/** Trigger the lanes this long before the stable mark, so they straddle the kill. */
const LANE_LEAD_MS = 6_000;

test('a killed app restarts on the same conversation with a real crash reason while its daemon and lanes keep working', async (t) => {
  // Before anything is built or launched: this suite needs a context that can
  // both start Electron and signal it. A sandboxed context can do neither, so it
  // gets the reason instead of three crashed instances and their dialogs.
  assertNotSandboxed(await isSandboxed());
  const startedAt = Date.now();
  const artifacts = await mkdtemp(join(tmpdir(), 'graph-crash-recovery-artifacts-'));
  const summary: Record<string, unknown> = { artifacts, startedAt };
  const note = (key: string, value: unknown) => { summary[key] = value; };
  const writeSummary = async () => {
    await writeFile(join(artifacts, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  };

  // The two branches this scenario relies on are the product's own rule, so the
  // test asserts the rule it is designing around instead of hard-coding a guess.
  expect(keeperDecision({ exitCode: null, signal: 'SIGKILL', uptimeMs: STABLE_MS, attempts: 0 }).action,
    'a run that lived the stable window restarts').toBe('restart');
  expect(keeperDecision({ exitCode: null, signal: 'SIGSEGV', uptimeMs: STABLE_MS - 1, attempts: 0, maxAttempts: 0 }).action,
    'an early death with no restart budget stops').toBe('stop-crash-loop');

  // The user's instance, snapshotted before anything else happens.
  const user = captureUserInstance();
  if (user.record?.pid) {
    await cp(userConsolePath, join(artifacts, 'baseline-console.json')).catch(() => undefined);
    note('baseline', user.record);
  }
  note('baselineAppPids', user.appPids);
  note('baselinePort', user.port);
  await assertUserInstance(user, 'before the test starts');

  const paths = instancePaths(await mkdtemp(join(tmpdir(), 'graph-crash-recovery-instance-')));
  note('instance', paths);
  let instanceBootedAt = 0;
  const definition = {
    schemaVersion: 2,
    name: 'Crash recovery lanes',
    protocols: { data: { type: 'object' } },
    nodes: {
      worker: { recipe: 'coder@1', model: 'sender', task: 'Stand by for the crash test', inputs: {}, outputs: {}, submission: {} },
    },
    modules: {
      lane1: laneModule('lane1', paths.lanesLog),
      lane2: laneModule('lane2', paths.lanesLog),
      lane3: laneModule('lane3', paths.lanesLog),
    },
    edges: {} as Record<string, unknown>,
    inputs: {},
    outputs: {},
  };

  const master = await masterProvider(() => {
    const graphId = String(summary.graphId ?? '');
    // Set before the conversation exists, so the lanes can never be due before
    // the app has a start time to be measured from.
    const lanesDueAt = instanceBootedAt > 0 ? instanceBootedAt + STABLE_MS - LANE_LEAD_MS : Number.POSITIVE_INFINITY;
    const holdUntilDue = async () => {
      while (Date.now() < lanesDueAt) await sleep(250);
    };
    return [
      { id: 'create', name: 'graph_create', args: { requestId: 'crash-lanes', definition } },
      // The lanes are deliberately due near the stable mark: they must still be
      // working when the app dies, and the app must already count as "working"
      // so the keeper's restart is the stable branch.
      { id: 'lane-1', name: 'graph_send', args: { graphId, nodeId: 'lane1', input: 'job', value: { lane: 1 } }, before: holdUntilDue },
      { id: 'lane-2', name: 'graph_send', args: { graphId, nodeId: 'lane2', input: 'job', value: { lane: 2 } } },
      { id: 'lane-3', name: 'graph_send', args: { graphId, nodeId: 'lane3', input: 'job', value: { lane: 3 } } },
      { id: 'inspect', name: 'graph_inspect', args: { graphId, query: 'nodes' } },
    ];
  }, (id, content) => {
    if (id !== 'create') return;
    const found = /"graphId"\s*:\s*"([^"]+)"/.exec(content);
    if (found) summary.graphId = found[1]!;
  });

  let browser: Browser | undefined;
  let page: Page | undefined;
  let instance: StartedInstance | undefined;
  let cdpPort = 0;
  const killed: number[] = [];

  try {
    await prepareInstance(paths, master.baseUrl);
    cdpPort = await freePort();
    note('cdpPort', cdpPort);

    // Serialized, capped, and checked against the user's app on both sides of
    // every launch. A machine that cannot start Electron says so by name. When
    // it does, the run is reported as a skip with that reason - the launch
    // discipline (one instance at a time, capped attempts, 0 dialogs) has
    // already been spent, and failing the suite would only say what the message
    // says: this host has no window session to give. The graph's own check
    // module runs the same file where it does (sandbox: false, GUI session).
    try {
      instance = await startIsolatedInstance({ paths, cdpPort, user, artifacts, startedAt });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      if (!detail.includes('环境阻塞')) throw reason;
      console.log(detail);
      console.log('[desktop-crash-recovery] skipped: this host cannot start an Electron window; 0 instances and 0 dialogs were spent');
      t.skip();
      return;
    }
    const { daemon } = instance;
    note('daemon', daemon);
    expect(daemon.url, 'the isolated instance must not share the user daemon address').not.toBe(user.record?.url);
    expect(alive(daemon.pid), 'the isolated daemon is a real process').toBe(true);
    await cp(paths.markerPath, join(artifacts, 'first-last-run.json'));
    const firstPid = Number(instance.firstRun.pid);
    instanceBootedAt = Number(instance.firstRun.bootedAt);
    expect(firstPid, 'the run marker names the app process').toBeGreaterThan(0);
    expect(firstPid, 'the app pid is not the daemon pid').not.toBe(daemon.pid);
    note('firstRun', { pid: firstPid, bootedAt: instanceBootedAt });

    const firstWindow = await connectWindow(cdpPort, 'first run').catch(async error => {
      await writeLaunchFailure({ artifacts, startedAt, reason: String(error), paths, cdpPort, output: instance!.keeper.output(), keeperLog: instance!.keeper.log() });
      throw error;
    });
    browser = firstWindow.browser;
    page = firstWindow.page;
    await expect.poll(() => page!.evaluate(() => Boolean((window as unknown as { graph?: { isDesktop?: boolean } }).graph?.isDesktop)),
      { timeout: 60_000 }).toBe(true);

    const home = await fetch(daemon.url);
    const headers = { origin: daemon.url, cookie: home.headers.get('set-cookie') ?? '', 'content-type': 'application/json' };
    const created = await fetch(`${daemon.url}/api/conversations`, {
      method: 'POST', headers, body: JSON.stringify({ model: 'main', text: 'Run the three lanes.', requestId: 'crash-lanes' }),
    });
    expect(created.status, `POST /api/conversations -> ${created.status}`).toBe(200);
    const conversation = await created.json() as { conversationId?: string; taskId?: string };
    expect(conversation.conversationId, 'the create call returns the conversation id').toBeTruthy();
    const conversationId = conversation.conversationId!;
    note('conversation', conversation);

    const graphId = await waitFor(() => typeof summary.graphId === 'string' ? summary.graphId : undefined,
      'the master to create the graph', 120_000);
    note('graphId', graphId);
    await expect.poll(() => master.failures.length, { timeout: 30_000 }).toBe(0);

    const route = `#/conversations/${conversationId}`;
    await page.evaluate(hash => { window.location.hash = hash; }, route);
    await expect.poll(() => readJsonSync(join(paths.userData, 'last-conversation-route.json')), { timeout: 30_000 }).toBe(route);
    await page.screenshot({ path: join(artifacts, 'before.png') }).catch(error => note('beforeScreenshotError', String(error)));

    // The lanes are driven one after another, so the last one to start is the
    // one running right now - that is the work the kill is aimed at.
    const laneStarts = await waitFor(() => {
      const lines = readLanes(paths.lanesLog);
      return new Set(lines.filter(line => line.kind === 'start').map(line => line.lane)).size >= 3 ? lines : undefined;
    }, 'the three lanes to start', 180_000);
    note('laneStarts', laneStarts);
    const runningLane = laneStarts.filter(line => line.kind === 'start').at(-1)!.lane;
    note('runningLane', runningLane);
    await sleep(300);
    while (Date.now() < instanceBootedAt + STABLE_MS + 300) await sleep(250);

    // What the daemon has already recorded for that lane. After the restart the
    // same list must still be its prefix: records continued, none rewritten.
    const moduleView = async () => {
      const response = await fetch(`${daemon.url}/api/tasks/${graphId}/graph/modules/${runningLane}`, { headers });
      return { status: response.status, body: await response.json().catch(() => ({})) as { transitions?: unknown[] } };
    };
    const beforeKillView = await moduleView();
    expect(beforeKillView.status, `${runningLane}: the module view answers before the kill`).toBe(200);
    note('moduleViewBeforeKill', beforeKillView.body);

    // Around the kill: the user's app, still untouched.
    await assertUserInstance(user, 'before the kill');
    const killedAt = Date.now();
    note('killedAt', killedAt);
    expect(killedAt - instanceBootedAt, 'the app was up for the keeper\'s stable window before the kill').toBeGreaterThanOrEqual(STABLE_MS);
    await browser.close().catch(() => undefined);
    browser = undefined;

    // a2: kill exactly the pid this test started, read from the product's own
    // marker - never by process name.
    killed.push(firstPid);
    process.kill(firstPid, 'SIGKILL');
    const crash = await waitFor(() => {
      const record = readJsonSync(paths.recordPath) as { pid?: number } | undefined;
      return record && record.pid === firstPid ? record : undefined;
    }, 'the keeper to record the abnormal exit', 90_000).catch(async error => {
      await writeLaunchFailure({ artifacts, startedAt, reason: String(error), paths, cdpPort, output: instance!.keeper.output(), keeperLog: instance!.keeper.log() });
      throw error;
    });
    await cp(paths.recordPath, join(artifacts, 'last-crash.json'));
    note('crashRecord', crash);

    // a3: the reason is real - the signal that killed it, and when it was seen.
    const crashRecord = crash as { pid: number; at: number; exitCode: number | null; signal: string | null; reason: string; source: string; ips?: string };
    expect(crashRecord.signal, 'the recorded reason names the signal that killed the run').toBe('SIGKILL');
    expect(crashRecord.exitCode, 'a signal death has no exit code').toBeNull();
    expect(crashRecord.at, 'the record was written after the kill').toBeGreaterThanOrEqual(killedAt - 1_000);
    expect(crashRecord.reason, 'the reason is the real one, not a placeholder').toContain('SIGKILL');
    expect(crashRecord.reason, 'the reason never falls back to "unknown"').not.toContain('未知');
    expect(crashRecord.source, 'the reason names where it came from').toMatch(/^(keeper|ips)$/);

    // a2: the same conversation comes back, on a new app process - still one
    // instance at a time, because the keeper starts it after the first is gone.
    const secondRun = await waitFor(() => {
      const record = readJsonSync(paths.markerPath) as { pid?: number } | undefined;
      return record && record.pid && record.pid !== firstPid ? record : undefined;
    }, 'the keeper to restart the app', 120_000).catch(async error => {
      await writeLaunchFailure({ artifacts, startedAt, reason: String(error), paths, cdpPort, output: instance!.keeper.output(), keeperLog: instance!.keeper.log() });
      throw error;
    });
    const secondPid = Number(secondRun.pid);
    killed.push(secondPid);
    note('secondRun', secondRun);
    await cp(paths.markerPath, join(artifacts, 'second-last-run.json'));
    expect(instance.keeper.log(), 'the keeper restarted the same conversation explicitly').toContain(`for conversation ${conversationId}`);
    await assertUserInstance(user, 'after the restart');

    const secondWindow = await connectWindow(cdpPort, 'after the restart').catch(async error => {
      await writeLaunchFailure({ artifacts, startedAt, reason: String(error), paths, cdpPort, output: instance!.keeper.output(), keeperLog: instance!.keeper.log() });
      throw error;
    });
    browser = secondWindow.browser;
    page = secondWindow.page;
    await expect.poll(() => page!.url(), { timeout: 90_000 }).toContain(route);
    await page.screenshot({ path: join(artifacts, 'after.png') }).catch(error => note('afterScreenshotError', String(error)));

    // a4: the daemon never restarted, so the lanes it was running finished their
    // work on the far side of the kill.
    const afterKill = readJsonSync(paths.consolePath) as { url?: string; pid?: number; startedAt?: number } | undefined;
    note('daemonAfterRestart', afterKill);
    expect(afterKill?.pid, 'the same daemon serves the restarted app').toBe(daemon.pid);
    expect(afterKill?.url, 'the daemon kept its address').toBe(daemon.url);
    expect(afterKill?.startedAt, 'the daemon never started over').toBe(daemon.startedAt);

    const finished = await waitFor(() => {
      const lines = readLanes(paths.lanesLog);
      return lines.filter(line => line.kind === 'end').length >= 3 ? lines : undefined;
    }, 'the three lanes to finish their work', 180_000);
    note('laneLines', finished);
    await cp(paths.lanesLog, join(artifacts, 'lanes.log'));
    // Every lane ran exactly once and finished exactly once (laneTimelines throws
    // otherwise): the kill neither restarted a lane nor lost one, and all of them
    // began inside this daemon's lifetime.
    const timelines = laneTimelines(finished);
    note('laneTimelines', timelines);
    for (const lane of timelines) {
      expect(lane.start, `${lane.lane} began inside the daemon's lifetime`).toBeGreaterThanOrEqual(daemon.startedAt);
    }
    // The kill landed inside the lane that was running: it kept working through
    // the kill and finished afterwards, with the app gone and then back.
    const running = timelines.find(lane => lane.lane === runningLane)!;
    expect(killedAt, `the kill landed inside ${runningLane}`).toBeGreaterThan(running.start);
    expect(running.end, `${runningLane} kept working across the kill and finished afterwards`).toBeGreaterThan(killedAt);
    // And the daemon's own record of that lane is the pre-kill list plus what
    // happened after: a prefix, not a rewrite.
    const afterKillView = await moduleView();
    expect(afterKillView.status, `${runningLane}: the module view answers after the restart`).toBe(200);
    const recordsBefore = beforeKillView.body.transitions ?? [];
    const recordsAfter = afterKillView.body.transitions ?? [];
    expect(Array.isArray(recordsAfter), 'the module view returns transitions').toBe(true);
    expect(recordsAfter.length, 'the lane gained records after the kill').toBeGreaterThanOrEqual(recordsBefore.length);
    expect(recordsAfter.slice(0, recordsBefore.length), 'the pre-kill records are still the same list').toEqual(recordsBefore);
    note('moduleViewAfterKill', afterKillView.body);

    const task = await fetch(`${daemon.url}/api/tasks/${graphId}`, { headers });
    expect(task.status, 'the graph task survived the restart').toBe(200);
    const taskBody = await task.json() as { id?: string };
    expect(taskBody.id, 'the task is still the same task').toBe(graphId);
    note('taskAfterRestart', taskBody);

    // a2: a normal exit does not restart. SIGTERM is the app's own stop path: it
    // quits, removes its marker, and the keeper sees exit code 0.
    const recordBefore = readFileSync(paths.recordPath, 'utf8');
    await assertUserInstance(user, 'before the normal exit');
    const keeperExit = new Promise<number | null>(resolve => instance!.keeper.process.once('exit', code => resolve(code)));
    process.kill(secondPid, 'SIGTERM');
    const exitCode = await keeperExit;
    expect(exitCode, 'the keeper stops when the app exits normally').toBe(0);
    expect(await readFile(paths.recordPath, 'utf8'), 'a normal exit writes no crash record').toBe(recordBefore);
    expect(existsSync(paths.markerPath), 'a normal exit removes the run marker').toBe(false);
    await sleep(3_000);
    const stillDown = readJsonSync(paths.consolePath) as { pid?: number } | undefined;
    expect(stillDown?.pid, 'no replacement app started after a normal exit').toBe(daemon.pid);
    note('keeperExitCode', exitCode);

    // a5: the user's instance, snapshot-to-snapshot against the one taken before
    // anything was launched - same pid, address and start time, still answering.
    await assertUserInstance(user, 'after the test');
    const userAfter = captureUserInstance();
    assertSameUserInstance(user, userAfter, 'after the test');
    note('baselineAfter', userAfter.record);
    expect(killed, 'this test never signalled the user process').not.toContain(user.record?.pid);
    note('killedPids', killed);
  } finally {
    note('finishedAt', Date.now());
    note('killedPids', killed);
    await writeSummary();
    await browser?.close().catch(() => undefined);
    await instance?.stop().catch(() => undefined);
    await master.close();
    await sleep(500);
    await rm(paths.root, { recursive: true, force: true }).catch(() => undefined);
  }

}, 600_000);
