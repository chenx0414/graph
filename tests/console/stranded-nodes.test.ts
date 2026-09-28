// Guard for HB-185: a one-shot drain must not silently strand a node.
//
// `runReady()` dispatches what is ready at that instant, so a node whose only dependency it just
// finished was still `waiting` during the scan. Production re-scans on the host's 40ms tick and
// never notices; a one-shot caller (every test, and anything that expects the graph drained) would
// see a chain sit at `pending` with no explanation -- which is exactly how HB-185 cost hours.
//
// `host.strandedNodes()` names that condition, so a caller can assert the drain is complete rather
// than infer it from node statuses.
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { installPresets } from '../../src/catalog/presets.ts';
import { openTaskRuntime } from '../../src/core/task-runtime.ts';
import { openaiServer } from '../fixtures/openai-server.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const action of cleanup.reverse()) await action();
  cleanup.length = 0;
});
const presetsRoot = fileURLToPath(new URL('../../presets', import.meta.url));

const handoff = (summary: string) => JSON.stringify({
  schemaVersion: 1, objective: 'step', outcome: 'completed', workSummary: summary,
  changes: [], decisions: [], verification: [], knownLimits: [], openQuestions: [], nextActions: [],
});

async function runtimeWithChain(links: number) {
  const root = await mkdtemp(join(tmpdir(), `graph-strand-${links}-`));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, 'project');
  await mkdir(workspace, { recursive: true });

  const submit = { tools: [{ id: 'submit', name: 'submit_result', arguments: JSON.stringify({ outputJson: handoff('step done') }) }] };
  const turns = Array.from({ length: 20 }, (_, index) => (index % 2 === 0 ? submit : { text: 'step done' }));
  const provider = await openaiServer(turns);
  cleanup.push(() => provider.close());

  const runtime = await openTaskRuntime({
    stateDir: join(root, 'state'),
    projects: [{ id: 'p', root: workspace }],
    actions: { check: { kind: 'program', prepare: async () => async () => ({ outcome: 'completed', output: null, evidence: [{ acceptanceId: 'ok', summary: 'ok', artifact: { path: join(workspace, 'ok.txt'), digest: 'a'.repeat(64) } }] }) } },
    models: { entries: [{ id: 'local', provider: 'graph-openai', grade: 'high', api: 'openai-completions', baseUrl: provider.model.baseUrl, contextWindow: 32_000, maxTokens: 256 }], apiKey: 'k', modelRuntime: provider.runtime },
  });
  cleanup.push(() => runtime.close());
  await installPresets(runtime.catalog, presetsRoot);

  const ids = Array.from({ length: links }, (_, index) => `n${index}`);
  const nodes = ids.map((id, index) => index === 0
    ? { id, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local' }
    : {
        id, kind: 'agent' as const, action: 'work', definitionVersion: 'coder@1', model: 'local',
        dependsOn: [ids[index - 1]!],
        context: { purpose: 'implement' as const, predecessors: [{ source: ids[index - 1]!, mode: 'result_handoff' as const }] },
      });

  const { taskId } = await runtime.user.begin({ projectId: 'p', request: `chain ${links}`, requestId: 'begin' });
  await runtime.supervisor(taskId).propose({
    requirementVersion: 1, summary: `chain ${links}`,
    acceptance: [{ id: 'ok', description: 'ok', checkNode: 'check' }],
    nodes: [...nodes, { id: 'check', kind: 'program', action: 'check', dependsOn: [ids[ids.length - 1]!] }],
  }, 'proposal');
  await runtime.user.task(taskId).accept({ proposalVersion: 1, targetBranch: 'main', requestId: 'accept' });
  return { runtime, taskId, stateDir: join(root, 'state') };
}

// The documented behaviour of a ONE-SHOT drain, which is exactly why the guard now exists. This is
// HB-185 pinned as a fact rather than as a defect: production re-scans on the host's 40ms tick, so
// it only ever sees a one-tick delay -- but a one-shot caller must not mistake this for "the chain
// ran", and `strandedNodes()` is how it can tell.
test('a single runReady pass reports the node it left stranded', async () => {
  const { runtime } = await runtimeWithChain(3);
  await runtime.host.runReady();
  expect(runtime.host.strandedNodes()).toContain('n1');
}, 120_000);

test('the guard names a node that IS stranded, so a silent hang cannot pass unnoticed', async () => {
  const { runtime, taskId, stateDir } = await runtimeWithChain(2);

  // Negative control: put the graph in exactly the state the guard exists to name -- a node still
  // `pending` while every dependency it has is already `succeeded`. Reaching this through a drain
  // is racy by nature (production re-scans every tick), so it is set up directly; what is under
  // test is that the guard reads this state and reports it, not how the state arose.
  const { TaskStore } = await import('../../src/core/store.ts');
  const store = new TaskStore(join(stateDir, 'tasks.sqlite'));
  store.db.prepare("UPDATE nodes SET status='succeeded' WHERE task_id=? AND id='n0'").run(taskId);
  store.db.prepare("UPDATE nodes SET status='pending' WHERE task_id=? AND id='n1'").run(taskId);
  store.close();

  expect(runtime.host.strandedNodes()).toContain('n1');
}, 120_000);
