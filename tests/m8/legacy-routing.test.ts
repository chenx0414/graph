import { describe, expect, test } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { TaskStore } from '../../src/core/store.ts';
import { routeSourceOf, backEdges } from '../../src/core/legacy-routing.ts';
import { ROUTE_SOURCE_KEY } from '../../src/core/router-action.ts';
import type { NodeSpec } from '../../src/core/types.ts';

/**
 * Issue #1 §13.8 (HB-277) — the old kernel's routing knowledge, now in one module.
 *
 * Extracting this out of `operation-lifecycle` is a pure move: the routing decisions stay
 * exactly where the product has always made them. What changes is that they are now
 * reachable in isolation, so the boundary can be tested instead of asserted — and so the
 * module can be retired with the old kernel rather than scattered through a live file.
 *
 * Failure modes first (R24):
 *   T1  a declared case is read from the node's own input
 *   T2  an Agent router may take its case from its own result (declared: null)
 *   T3  a program with no way to choose a case is refused, not silently routed nowhere
 *   T4  a node that declares no routing at all reports no source
 *   T5  backEdges reads the old graph's loops once, and can match a route case
 */

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const action of cleanup.reverse()) await action(); cleanup.length = 0; });

const agent = (overrides: Partial<NodeSpec> = {}): NodeSpec => ({
  id: 'n', kind: 'agent', action: 'review', ...overrides,
} as NodeSpec);

describe('routeSourceOf — how a router was told to pick its case (HB-277)', () => {
  test('T1: a declared case is read from the node own input', () => {
    const spec = agent({ input: { [ROUTE_SOURCE_KEY]: { declared: 'failed' } } as never });
    expect(routeSourceOf(spec)).toEqual({ declared: 'failed' });
  });

  test('T2: an Agent router may take its case from its own result', () => {
    const spec = agent({ input: { [ROUTE_SOURCE_KEY]: { declared: null } } as never });
    expect(routeSourceOf(spec)).toEqual({ declared: null });
  });

  test('T3: a program with no way to choose a case is refused, not silently routed nowhere', () => {
    // `declared: null` only an Agent can speak for itself; a program must map status or a field.
    const program = { ...agent({ input: { [ROUTE_SOURCE_KEY]: { declared: null } } as never }), kind: 'program' } as NodeSpec;
    expect(routeSourceOf(program)).toBeNull();
  });

  test('T4: a node that declares no routing at all reports no source', () => {
    expect(routeSourceOf(agent())).toBeNull();
    expect(routeSourceOf(agent({ input: { [ROUTE_SOURCE_KEY]: 'not-an-object' } as never }))).toBeNull();
  });
});

test('T5: backEdges reads the old graph loops once, and can match a route case', async () => {
  const root = await mkdtemp(join(tmpdir(), 'legacy-routing-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const store = new TaskStore(join(root, 'tasks.sqlite'));
  cleanup.push(() => store.close());
  store.db.prepare("INSERT INTO projects VALUES('p','/tmp','[]')").run();
  store.db.prepare("INSERT INTO tasks(id,project_id,request,graph_version,created_seq) VALUES('g1','p','r',1,1)").run();
  // A graph with two back edges out of `w`: one unconditional, one only on the 'failed' case.
  const proposal = {
    requirementVersion: 1, summary: 'looping',
    acceptance: [{ id: 'done', description: 'd', checkNode: 'w' }],
    nodes: [
      { id: 'a', kind: 'agent', action: 'work' },
      { id: 'b', kind: 'agent', action: 'work' },
      { id: 'w', kind: 'agent', action: 'work', dependsOn: ['a', 'b'], routes: ['failed', 'passed'] },
    ],
    loops: [{ from: 'w', to: 'a' }, { from: 'w', to: 'b', case: 'failed' }],
  };
  store.db.prepare('INSERT INTO graph_revisions(task_id,version,spec,reason,base_version) VALUES(?,?,?,?,0)')
    .run('g1', 1, JSON.stringify(proposal), 'test');
  for (const [id, deps] of [['a', []], ['b', []], ['w', ['a', 'b']]] as [string, string[]][]) {
    store.db.prepare("INSERT INTO nodes(task_id,id,spec,status) VALUES('g1',?,?,'completed')")
      .run(id, JSON.stringify({
        id, kind: 'agent', action: 'work',
        ...(deps.length ? { dependsOn: deps } : {}),
        ...(id === 'w' ? { routes: ['failed', 'passed'] } : {}),
      }));
  }

  // Both back edges are visible when no case is named; only the matching one when a case is.
  expect(backEdges(store, 'g1', 'w').sort()).toEqual(['a', 'b']);
  expect(backEdges(store, 'g1', 'w', 'failed')).toEqual(['b']);
  expect(backEdges(store, 'g1', 'w', 'passed')).toEqual([]);
});