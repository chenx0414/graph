import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

import { expect, test } from 'vitest';

import { launchCli } from '../helpers/cli-daemon.ts';

import {
  ACCEPTED_DEFINITION, type AcceptanceReport, type ClosureResult, type HumanCheckRow, type LimitationRecord,
  type MasterCall, answeredGraphId, graphIdOf, humanChecks, limitationRows, masterProvider, waitForStep,
} from './acceptance-limitations.fixture.ts';

/**
 * What a user's waiver really settles.
 *
 * A graph can be left with one debt nobody but the user can decide. The user
 * waives it through the HTTP door that speaks as them, and that decision has to
 * be complete: the open human acceptance question it replaces is answered, the
 * criterion stops being listed as something the user is still being asked, a
 * later settle does not ask again - and one closure is left that records
 * nothing, because there is nothing left to limit.
 */
test('a user waiver answers the open human check, leaves no human debt, and lets the graph close with no limitation left to record', async () => {
  const root = await mkdtemp(join(tmpdir(), 'graph-e2e-acceptance-waiver-'));
  const project = join(root, 'project');
  await mkdir(join(project, 'test'), { recursive: true });
  await mkdir(join(root, 'web'), { recursive: true });
  await writeFile(join(root, 'web', 'index.html'), '<!doctype html><div id="root">Graph</div>');
  await writeFile(join(project, 'test', 'pass.js'), 'console.log("check passed");\n');

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

  /** The graph the first step created: a step built too early has no id yet. */
  const created = () => answeredGraphId(master, 'create');

  // Read at the step that describes them: the plan does not wait for assertions.
  const questionsBeforeWaive: HumanCheckRow[][] = [];
  const questionsAfterWaive: HumanCheckRow[][] = [];
  const questionsAfterSettle: HumanCheckRow[][] = [];
  const waiveResults: ClosureResult[] = [];

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

    plan = () => {
      const graphId = graphIdOf(master.results.get('create'));
      return [
        { id: 'create', name: 'graph_create', args: { requestId: 'create', definition: ACCEPTED_DEFINITION } },
        { id: 'run', name: 'graph_send', args: { graphId, nodeId: 'check', input: 'job', value: { marker: 'go' } } },
        {
          id: 'operations', name: 'graph_inspect', args: { graphId, query: 'operations' },
          until: results => (results.get('operations') ?? '').includes('"passed":true'),
        },
        { id: 'complete', name: 'graph_control', args: { graphId, action: 'complete' } },
        {
          id: 'acceptance-blocked', name: 'graph_inspect', args: { graphId, query: 'acceptance' },
          before: async () => { await waitPhase(created(), 'blocked'); },
        },
        {
          id: 'checks-before-waive', name: 'graph_inspect', args: { graphId, query: 'summary' },
          before: async () => { questionsBeforeWaive.push(humanChecks(root, created(), 'human')); },
        },
        {
          // The user's own decision, through the one route that speaks as the user.
          id: 'acceptance-after-waive', name: 'graph_inspect', args: { graphId, query: 'acceptance' },
          before: async () => {
            const waived = await waive(created(), {
              acceptanceId: 'human', reason: 'The delivered result is what the user asked for',
              evidence: 'user message 2026-10-24 "ship it"', requestId: 'waive-human',
            });
            expect(waived.status, JSON.stringify(waived.body)).toBe(200);
            waiveResults.push(waived.body as ClosureResult);
            questionsAfterWaive.push(humanChecks(root, created(), 'human'));
          },
        },
        {
          // A completion asked for again settles the graph again: the waived
          // criterion must not be asked a second time.
          id: 'settle-again', name: 'graph_control', args: { graphId, action: 'complete' },
        },
        {
          id: 'acceptance-after-settle', name: 'graph_inspect', args: { graphId, query: 'acceptance' },
          before: async () => {
            await waitPhase(created(), 'blocked');
            questionsAfterSettle.push(humanChecks(root, created(), 'human'));
          },
        },
        {
          // Nothing is left to limit: the closure records no limitation at all.
          id: 'close', name: 'graph_control',
          args: { graphId, action: 'complete_with_limitations', requestId: 'close-accepted', limitations: [] },
        },
        { id: 'summary', name: 'graph_inspect', args: { graphId, query: 'summary' } },
        { id: 'limitations', name: 'graph_inspect', args: { graphId, query: 'limitations' } },
      ];
    };

    const started = await request('/api/conversations', {
      method: 'POST', body: JSON.stringify({ projectId: 'p', model: 'main', text: 'Only the user is left.', requestId: 'waiver-begin' }),
    });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    await waitForStep(master, 'limitations', 240_000);
    const answerId = created();

    // The check passed, so the graph asked the user the only question it had.
    const blocked = JSON.parse(master.results.get('acceptance-blocked')!) as AcceptanceReport;
    expect(blocked.ready).toBe(false);
    // The question is open, so the graph is not drained and nothing can close it yet.
    expect(blocked.drained).toBe(false);
    expect(blocked.closable).toBe(false);
    expect(blocked.human.map(criterion => criterion.id)).toEqual(['human']);
    expect(questionsBeforeWaive).toHaveLength(1);
    expect(questionsBeforeWaive[0]!.map(row => row.status)).toEqual(['open']);

    // The waiver answers the question it replaces.
    // The waiver's own answer already re-read the report the same way.
    const waived = waiveResults[0]!;
    expect(waived.acceptance.human).toEqual([]);
    expect(waived.phase).toBe('blocked');
    expect(questionsAfterWaive).toHaveLength(1);
    expect(questionsAfterWaive[0]!.map(row => row.status)).toEqual(['resolved']);
    const answer = JSON.parse(questionsAfterWaive[0]![0]!.answer!) as { type: string; actor: string; evidence: string; commitSha: string | null };
    expect(answer).toMatchObject({ type: 'waived', actor: 'user', evidence: 'user message 2026-10-24 "ship it"', commitSha: null });

    // The criterion is decided, not merely recorded: it is out of the human list,
    // and with the question answered the graph is drained and closable.
    const reread = JSON.parse(master.results.get('acceptance-after-waive')!) as AcceptanceReport;
    expect(reread.human).toEqual([]);
    expect(reread.drained).toBe(true);
    expect(reread.closable).toBe(true);
    expect(reread.ready).toBe(false);
    expect(reread.items.map(item => [item.id, item.status])).toEqual([['check', 'passed'], ['human', 'waived']]);

    // A later settle of the same blocked graph does not ask the user again.
    expect((JSON.parse(master.results.get('settle-again')!) as { phase: string }).phase).toBe('completing');
    expect(questionsAfterSettle).toHaveLength(1);
    expect(questionsAfterSettle[0]!.map(row => row.status)).toEqual(['resolved']);
    const afterSettle = JSON.parse(master.results.get('acceptance-after-settle')!) as AcceptanceReport;
    expect(afterSettle.human).toEqual([]);
    expect(afterSettle.items.map(item => [item.id, item.status])).toEqual([['check', 'passed'], ['human', 'waived']]);

    // The one door left: a closure with nothing to record, because nothing is
    // left to limit. The user's waiver is still the record it rests on.
    expect(master.results.get('close')!, 'nothing is left to limit, so this closure records nothing and is accepted')
      .not.toContain('Tool failed');
    const closed = JSON.parse(master.results.get('close')!) as ClosureResult;
    expect(closed.phase).toBe('completed');
    expect(closed.replayed).toBe(false);
    expect(closed.limitations.map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);
    expect((JSON.parse(master.results.get('summary')!) as { phase: string }).phase).toBe('completed');
    // Nothing was added by the closure itself.
    expect(limitationRows(root, answerId).map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);
    const recorded = JSON.parse(master.results.get('limitations')!) as LimitationRecord[];
    expect(recorded.map(record => [record.acceptanceId, record.actor])).toEqual([['human', 'user']]);
    // The question was answered once and stayed answered.
    expect(humanChecks(root, answerId, 'human').map(row => row.status)).toEqual(['resolved']);
  } finally {
    await daemon?.close(); await master.close();
    await rm(root, { recursive: true, force: true });
  }
}, 300_000);
