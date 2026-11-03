import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

import {
  CLOSABLE_DEFINITION, FAILING_DEFINITION, type AcceptanceReport, type ClosureResult,
  type LimitationRecord, type MasterCall, answeredGraphId, completionWakeLimitations, graphIdOf, limitationRows,
  masterProvider, waitForStep,
} from './acceptance-limitations.fixture.ts';

/**
 * Closing a blocked graph with recorded limitations.
 *
 * A graph whose acceptance can never be proved - the check nobody ran, the
 * human acceptance the user is willing to skip - used to stay blocked forever.
 * The closure path this test proves is explicit and traceable: the caller names
 * every unmet item, says why the evidence is missing and where that decision is
 * recorded, and the kernel keeps one append-only row per item. Everything that
 * really failed, went stale, or belongs to the user is refused, and a refusal
 * writes nothing.
 *
 * The proof is a real daemon and real HTTP: the master Agent creates both
 * graphs through its own tools (so the Agent door is the one being refused),
 * and the user's waiver goes through the one route that speaks as the user.
 */
test('a blocked graph closes with recorded limitations, refuses everything it may not waive, and keeps the user’s own waiver in the same records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-acceptance-limitations-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  // The graph's own host checks: one that passes, and one that really fails.
  await writeFile(join(project, 'test', 'pass.js'), 'console.log("check passed");\n');
  await writeFile(join(project, 'test', 'fails.js'), 'console.error("check failed");\nprocess.exit(1);\n');

  // The plan is rebuilt on every provider request, so a step's arguments can
  // read what the earlier steps already answered.
  let plan: () => MasterCall[] = () => [];
  const master = await masterProvider(() => plan());
  let daemon: Awaited<ReturnType<typeof launchCli>> | undefined;

  const request = async (path: string, init: RequestInit = {}) => {
    const response = await daemon!.request(path, init);
    return { status: response.status, body: await response.json().catch(() => ({})) as any };
  };
  const control = async (graphId: string, body: Record<string, unknown>) =>
    request(`/api/tasks/${graphId}/graph/control`, { method: 'POST', body: JSON.stringify(body) });
  const waive = async (graphId: string, body: Record<string, unknown>) =>
    request(`/api/tasks/${graphId}/graph/acceptance/waive`, { method: 'POST', body: JSON.stringify(body) });
  const waitPhase = async (graphId: string, wanted: string) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      const view = await request(`/api/tasks/${graphId}`);
      if ((view.body as { phase?: string }).phase === wanted) return;
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`the graph never reached the phase ${wanted}`);
  };
  const waiveResults: ClosureResult[] = [];
  // The rows are read while the plan is still running, at the step that describes
  // the state they belong to: the plan does not wait for the assertions.
  const rowsAfterRefusal: LimitationRecord[][] = [];
  const rowsAfterAgentRefusal: LimitationRecord[][] = [];
  const rowsAfterWaive: LimitationRecord[][] = [];

  try {
    const configPath = join(root, 'graph.config.json');
    await writeFile(configPath, JSON.stringify({
      version: 1,
      projects: [{ id: 'p', root: project }],
      credentials: { limits: { secretRef: 'GRAPH_LIMITS_KEY' } },
      models: { entries: [{ id: 'main', provider: 'graph-master', modelId: 'main-model', grade: 'high', api: 'openai-completions',
        baseUrl: master.baseUrl, contextWindow: 32000, maxTokens: 256, credentialId: 'limits' }] },
    }));
    daemon = await launchCli(root, { configPath, env: { GRAPH_LIMITS_KEY: 'limits-synthetic' }, extraArgs: ['--execute'] });

    plan = () => [
      { id: 'create-closable', name: 'graph_create', args: { requestId: 'create-closable', definition: CLOSABLE_DEFINITION } },
      {
        id: 'complete-closable', name: 'graph_control',
        args: { graphId: graphIdOf(master.results.get('create-closable')), action: 'complete' },
      },
      {
        id: 'acceptance-blocked', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'acceptance' },
        before: async () => { await waitPhase(answeredGraphId(master, 'create-closable'), 'blocked'); },
      },
      { id: 'limitations-before', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'limitations' } },
      {
        // A limitation without a reason is not a record, it is a shrug.
        id: 'reject-no-reason', name: 'graph_control',
        args: {
          graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'no-reason',
          limitations: [{ acceptanceId: 'unrun', evidence: 'a chat message that names no reason' }],
        },
      },
      {
        id: 'limitations-after-refusal', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'limitations' },
        before: async () => { rowsAfterRefusal.push(limitationRows(root, answeredGraphId(master, 'create-closable'))); },
      },
      { id: 'phase-after-refusal', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'summary' } },
      {
        // Nothing is left to limit only when nothing is unmet: this graph still
        // owes two items, so a closure that records nothing names them instead.
        id: 'reject-empty-closure', name: 'graph_control',
        args: { graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'empty-closure', limitations: [] },
      },
      {
        // The Agent may not sign for the user, whatever it says in the payload.
        id: 'reject-human-agent', name: 'graph_control',
        args: {
          graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'agent-human',
          actor: 'user',
          // The batch covers the check as well, so the refusal can only come from
          // the human item - and it still writes nothing, not even for 'unrun'.
          limitations: [
            { acceptanceId: 'human', reason: 'The user is fine with it', evidence: 'the Agent says so' },
            { acceptanceId: 'unrun', reason: 'Nobody will run this check', evidence: 'the Agent decided so' },
          ],
        },
      },
      {
        // The user's own decision, through the one route that speaks as the user.
        id: 'limitations-after-waive', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'limitations' },
        before: async () => {
          rowsAfterAgentRefusal.push(limitationRows(root, answeredGraphId(master, 'create-closable')));
          const waived = await waive(answeredGraphId(master, 'create-closable'), {
            acceptanceId: 'human', reason: 'The delivered result is what the user asked for',
            evidence: 'user message 2026-10-24 "ship it"', requestId: 'waive-human',
          });
          expect(waived.status, JSON.stringify(waived.body)).toBe(200);
          waiveResults.push(waived.body as ClosureResult);
        },
      },
      {
        // The graph closes on the records: the user's waiver plus the check nobody ran.
        id: 'close-closable', name: 'graph_control',
        before: async () => { rowsAfterWaive.push(limitationRows(root, answeredGraphId(master, 'create-closable'))); },
        args: {
          graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'close-closable',
          limitations: [{ acceptanceId: 'unrun', reason: 'The check is out of scope for this iteration', evidence: 'decision #2732: the check is not implemented' }],
        },
      },
      {
        // The same requestId replays the same closure instead of recording again.
        id: 'replay-closable', name: 'graph_control',
        args: {
          graphId: graphIdOf(master.results.get('create-closable')), action: 'complete_with_limitations', requestId: 'close-closable',
          limitations: [{ acceptanceId: 'unrun', reason: 'The check is out of scope for this iteration', evidence: 'decision #2732: the check is not implemented' }],
        },
      },
      { id: 'acceptance-closed', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'acceptance' } },
      { id: 'limitations-closed', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-closable')), query: 'limitations' } },
      { id: 'create-failing', name: 'graph_create', args: { requestId: 'create-failing', definition: FAILING_DEFINITION } },
      {
        id: 'run-failing', name: 'graph_send',
        args: { graphId: graphIdOf(master.results.get('create-failing')), nodeId: 'failing', input: 'job', value: { marker: 'go' } },
      },
      {
        id: 'failing-operations', name: 'graph_inspect',
        args: { graphId: graphIdOf(master.results.get('create-failing')), query: 'operations' },
        until: results => (results.get('failing-operations') ?? '').includes('"passed":false'),
      },
      {
        id: 'complete-failing', name: 'graph_control',
        args: { graphId: graphIdOf(master.results.get('create-failing')), action: 'complete' },
      },
      {
        // A check that ran and failed is not missing evidence: it cannot be waived.
        id: 'reject-failed', name: 'graph_control',
        args: {
          graphId: graphIdOf(master.results.get('create-failing')), action: 'complete_with_limitations', requestId: 'failed-item',
          limitations: [{ acceptanceId: 'fails', reason: 'The check is inconvenient', evidence: 'no decision covers a failing check' }],
        },
        before: async () => { await waitPhase(answeredGraphId(master, 'create-failing'), 'blocked'); },
      },
      { id: 'failing-phase', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-failing')), query: 'summary' } },
      { id: 'failing-limitations', name: 'graph_inspect', args: { graphId: graphIdOf(master.results.get('create-failing')), query: 'limitations' } },
    ];

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Close both graphs the honest way.', requestId: 'limits-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await waitForStep(master, 'failing-limitations', 240_000);

    const closableId = answeredGraphId(master, 'create-closable');
    const failingId = answeredGraphId(master, 'create-failing');
    // The plain completion is what put the graph in front of its acceptance.
    expect((JSON.parse(master.results.get('complete-closable')!) as { phase: string }).phase).toBe('completing');

    // A blocked graph: two unmet items, nothing else in the way. The host check
    // was never run (missing, not failed), the human acceptance is the user's.
    const blocked = JSON.parse(master.results.get('acceptance-blocked')!) as AcceptanceReport;
    expect(blocked.ready).toBe(false);
    expect(blocked.items.map(item => [item.id, item.status, item.kind]))
      .toEqual([['unrun', 'missing', 'check'], ['human', 'missing', 'human']]);
    // The Agent cannot close this graph on its own: the human item needs the user.
    expect(blocked.closable).toBe(false);
    expect(JSON.parse(master.results.get('limitations-before')!)).toEqual([]);

    // The refusal names the reason it lacks, and nothing was written.
    expect(master.results.get('reject-no-reason')).toContain('reason');
    expect(master.results.get('reject-no-reason')).toContain('unrun');
    expect(JSON.parse(master.results.get('limitations-after-refusal')!)).toEqual([]);
    expect(rowsAfterRefusal).toEqual([[]]);
    // A refusal leaves the graph where it was.
    expect((JSON.parse(master.results.get('phase-after-refusal')!) as { phase: string }).phase).toBe('blocked');

    // A closure with no limitation is refused while items are still owed, and it
    // names them: the empty door is only for a graph with nothing left to limit.
    const emptyClosure = master.results.get('reject-empty-closure')!;
    expect(emptyClosure).toContain('unrun');
    expect(emptyClosure).toContain('human');

    // The Agent may not sign the user's acceptance, even by claiming to be them.
    const signedByAgent = master.results.get('reject-human-agent')!;
    expect(signedByAgent).toContain('human');
    expect(signedByAgent.toLowerCase()).toContain('user');
    expect(rowsAfterAgentRefusal).toEqual([[]]);

    // The user's waiver is recorded as the user's, with the version it covers.
    const waived = waiveResults[0]!;
    expect(waived.phase).toBe('blocked');
    expect(waived.limitations).toHaveLength(1);
    expect(waived.limitations[0]).toMatchObject({
      acceptanceId: 'human', actor: 'user', requestId: 'waive-human',
      reason: 'The delivered result is what the user asked for', evidence: 'user message 2026-10-24 "ship it"',
    });
    expect(waived.acceptance.items.find(item => item.id === 'human')).toMatchObject({
      status: 'waived', waived: true, limitation: { actor: 'user' },
    });
    // Now that the user has spoken, the missing check is the only thing in the way.
    expect(waived.acceptance.closable).toBe(true);
    // The user's waiver and the Agent's limitation are the same records, read in one place.
    expect(rowsAfterWaive).toHaveLength(1);
    expect(rowsAfterWaive[0]!.map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);
    const afterWaive = JSON.parse(master.results.get('limitations-after-waive')!) as LimitationRecord[];
    expect(afterWaive.map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);

    // The closure itself: completed, with every limitation the closure rests on.
    const closed = JSON.parse(master.results.get('close-closable')!) as ClosureResult;
    expect(closed.phase).toBe('completed');
    expect(closed.replayed).toBe(false);
    expect(closed.limitations.map(record => [record.acceptanceId, record.actor]))
      .toEqual([['human', 'user'], ['unrun', 'agent']]);
    const unrun = closed.limitations.find(record => record.acceptanceId === 'unrun')!;
    expect(unrun).toMatchObject({
      reason: 'The check is out of scope for this iteration', evidence: 'decision #2732: the check is not implemented',
      revisionVersion: 1, requestId: 'close-closable',
    });

    // The replay is the same closure: no second row, still completed.
    const replay = JSON.parse(master.results.get('replay-closable')!) as ClosureResult;
    expect(replay.replayed).toBe(true);
    expect(replay.phase).toBe('completed');
    expect(replay.limitations).toHaveLength(closed.limitations.length);
    expect(limitationRows(root, closableId).map(record => record.acceptanceId).sort()).toEqual(['human', 'unrun']);

    // Acceptance still tells the truth: nothing here passed, so it is not ready.
    const acceptance = JSON.parse(master.results.get('acceptance-closed')!) as AcceptanceReport;
    expect(acceptance.ready).toBe(false);
    expect(acceptance.closable).toBe(true);
    expect(acceptance.items.map(item => [item.id, item.status, item.waived]))
      .toEqual([['unrun', 'waived', true], ['human', 'waived', true]]);
    expect(acceptance.items.find(item => item.id === 'unrun')!.limitation).toMatchObject({
      reason: 'The check is out of scope for this iteration', actor: 'agent', commit: null,
    });
    const records = JSON.parse(master.results.get('limitations-closed')!) as LimitationRecord[];
    expect(records.map(record => record.acceptanceId)).toEqual(['human', 'unrun']);

    // The completion event and the wake the master receives carry the same records.
    const events = await request(`/api/tasks/${closableId}/events`);
    const completedEvents = (events.body as { type: string; data?: { revision?: number; limitations?: LimitationRecord[] } }[])
      .filter(event => event.type === 'graph.completed');
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]!.data!.limitations!.map(record => record.acceptanceId)).toEqual(['human', 'unrun']);
    expect(completionWakeLimitations(root, closableId).map(record => record.acceptanceId)).toEqual(['human', 'unrun']);

    // A check that really failed is not missing evidence, so it stays unwaivable.
    // (A stale item - evidence bound to an older commit - is refused by the same
    // guard; reaching it needs a Git graph whose delivered commit moved after the
    // check ran, which this test does not own.)
    const refusedFailed = master.results.get('reject-failed')!;
    expect(refusedFailed).toContain('fails');
    expect(refusedFailed).toContain('failed');
    expect(limitationRows(root, failingId)).toEqual([]);
    expect((JSON.parse(master.results.get('failing-phase')!) as { phase: string }).phase).toBe('blocked');
    expect(JSON.parse(master.results.get('failing-limitations')!)).toEqual([]);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 420_000);
