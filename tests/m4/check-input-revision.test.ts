import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { applyRevision } from '../../src/core/revision.ts';
import { TaskStore } from '../../src/core/store.ts';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

// The smallest graph that carries an acceptance item backed by a program check:
// one agent lane and one graph.command check that runs a test file.
function proposal(checkArgs: string[]) {
  return {
    requirementVersion: 1,
    summary: 'HB-26 fixture: a confirmed acceptance check that cannot run.',
    acceptance: [{ id: 'suite-runs', description: 'The suite runs', checkNode: 'check' }],
    nodes: [
      { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'local' },
      { id: 'check', kind: 'program', action: 'graph.command', dependsOn: ['work'], input: { command: 'node', args: checkArgs } },
    ],
  };
}

/** A store holding one task whose proposal is confirmed, so a revision is allowed to touch it. */
async function confirmed(input: { proved: boolean }) {
  const dir = await mkdtemp(join(tmpdir(), 'graph-check-input-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const store = new TaskStore(join(dir, 'state.sqlite'));
  const spec = proposal(['--test', 'tests/m1/execution.test.ts']);
  store.db.prepare('INSERT INTO projects(id, root, grants) VALUES(?,?,?)').run('p', dir, '[]');
  store.db.prepare('INSERT INTO tasks(id, project_id, request, requirement_version, latest_proposal, accepted_proposal, target_branch, phase, created_seq, graph_version) VALUES(?,?,?,?,?,?,?,?,?,?)')
    .run('t', 'p', 'make the check runnable', 1, 1, 1, 'main', 'executing', 1, 1);
  store.db.prepare('INSERT INTO proposals(task_id, version, requirement_version, spec) VALUES(?,?,?,?)').run('t', 1, 1, JSON.stringify(spec));
  store.db.prepare('INSERT INTO graph_revisions(task_id, version, spec, reason) VALUES(?,?,?,?)').run('t', 1, JSON.stringify(spec), 'initial graph');
  for (const node of spec.nodes) {
    store.db.prepare('INSERT INTO nodes(task_id, id, spec, status) VALUES(?,?,?,?)').run('t', node.id, JSON.stringify(node), 'succeeded');
  }
  if (input.proved) {
    // The check ran and its evidence for the acceptance item is valid, so it has
    // proved the behaviour: its input must stay frozen from here on.
    store.db.prepare('INSERT INTO operations(id, task_id, node_id, generation, spec, state, reserved) VALUES(?,?,?,?,?,?,?)')
      .run('op', 't', 'check', 1, '{}', 'settled', 0);
    store.db.prepare('INSERT INTO evidence(id, task_id, node_id, operation_id, acceptance_id, proposal_version, requirement_version, data, valid) VALUES(?,?,?,?,?,?,?,?,?)')
      .run('e', 't', 'check', 'op', 'suite-runs', 1, 1, '{}', 1);
  }
  return store;
}

function revision(store: TaskStore, args: string[]) {
  return () => applyRevision(store, 't', {
    baseVersion: 1,
    reason: 'the check could not execute at all: the sandbox denied its temporary repository, so re-point it at a suite that runs',
    nodes: proposal(args).nodes,
  });
}

test('a check that never produced valid evidence may be re-pointed with a reason', async () => {
  const store = await confirmed({ proved: false });
  expect(revision(store, ['--test', 'tests/m4/check-input-revision.test.ts'])).not.toThrow();
  const stored = JSON.parse((store.db.prepare('SELECT spec FROM graph_revisions WHERE task_id=? AND version=?').get('t', 2) as { spec: string }).spec) as { nodes: { id: string; input?: { args?: string[] } }[] };
  expect(stored.nodes.find(node => node.id === 'check')?.input?.args).toEqual(['--test', 'tests/m4/check-input-revision.test.ts']);
});

test('a check that proved its acceptance item keeps its confirmed input', async () => {
  const store = await confirmed({ proved: true });
  expect(revision(store, ['--test', 'tests/m4/check-input-revision.test.ts'])).toThrow(/confirmed input of an acceptance check/);
});
