import { describe, expect, test } from 'vitest';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import type { NodeSpec } from '../../src/core/types.ts';
import { droppedLegacyFields, liftDefinition, withLiftedDefinition } from '../fixtures/v2-lift.ts';

/**
 * Issue #1 ADR 0030 / HB-279: the test-only lift from the old declarative proposal shape
 * to the v2 graph definition.
 *
 * This fixture is the tool the 78-file migration runs on, so its own failure modes are
 * worth pinning before it is trusted with anyone else's tests. A lift that silently
 * produced an illegal or meaningless graph would migrate every assertion in the suite
 * onto a graph that never meant what the test was about - and the tests would still
 * look green.
 *
 * Failure modes first (R24):
 *   L1  the real parser accepts what the lift produces (otherwise 78 files break at once)
 *   L2  node ids survive, so a test's own node names and acceptance ids still mean something
 *   L3  `dependsOn` becomes a real, enabled edge - not a dropped scheduling hint
 *   L4  an already-v2 proposal is returned untouched, never re-lifted
 *   L5  the lift is not the converter ADR 0030 refused: no product code path calls it
 */

const chain = [
  { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'scripted' },
  { id: 'check', kind: 'program', action: 'check', dependsOn: ['work'] },
] as unknown as NodeSpec[];

describe('the test-only lift onto a v2 definition (HB-279)', () => {
  test('L1: the real parser accepts what the lift produces', () => {
    expect(() => parseGraphDefinition(liftDefinition(chain))).not.toThrow();
  });

  test('L2: node ids survive the lift, so test names and acceptance ids keep meaning something', () => {
    const definition = liftDefinition(chain);
    expect(Object.keys(definition.nodes).sort()).toEqual(['check', 'work']);
  });

  test('L3: dependsOn becomes a real enabled edge rather than being dropped', () => {
    const definition = liftDefinition(chain);
    expect(definition.edges['work->check']).toEqual({ from: 'work.out', to: 'check.in', enabled: true });
  });

  test('L4: an already-v2 proposal is returned untouched, never re-lifted', () => {
    const existing = liftDefinition(chain);
    const proposal = { requirementVersion: 1, summary: 's', acceptance: [], nodes: chain, definition: existing } as never;
    expect(withLiftedDefinition(proposal)).toBe(proposal);
  });

  test('L5: the lift lives in tests only - no product module imports it', async () => {
    // A product-side converter is exactly what ADR 0030 refused; if this ever fails, the
    // compatibility path has crept back into src/.
    const { spawnSync } = await import('node:child_process');
    const hits = spawnSync('grep', ['-rl', 'v2-lift', 'src/'], { encoding: 'utf8' });
    // grep exits 1 when nothing matched, which is the state we want; any output means
    // product code has started depending on the lift.
    expect(hits.stdout.trim()).toBe('');
  });
});
/**
 * Issue #1 HB-308: the lift must report what it cannot carry.
 *
 * The old shape carries fields the v2 definition has no place for: `context`, `container`,
 * `routes`, `when`, `optional`, `verifier`, `replaces`, `deliverable`. They were dropped
 * silently, which is indistinguishable from "that field did not matter" - and `input` was
 * dropped exactly this way before anyone noticed (HB-301).
 *
 * The scripted lane reads `input` back from the confirmed proposal precisely because the
 * definition cannot hold it. Anything else a test relies on needs the same treatment, or a
 * report saying it was left behind.
 *
 *   L9  the lift lists the legacy fields it did not carry
 *   L10 a node with none of them carries nothing, so nothing is reported
 */
describe('the lift reports what it cannot carry (HB-308)', () => {
  const legacyFields = [
    'input', 'context', 'container', 'routes', 'when', 'optional', 'verifier', 'replaces', 'deliverable', 'role',
  ];

  test('L9: every legacy field a node carries but the definition drops is named', () => {
    const node = {
      id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm',
      input: { files: ['a.ts'] },
      context: { purpose: 'implement' },
      container: 'group', routes: ['r1'], when: 'a', optional: true,
      verifier: { type: 'gate' }, replaces: 'x', deliverable: { path: 'out.md' }, role: 'worker',
    } as unknown as NodeSpec;
    const definition = liftDefinition([node]);
    // Whatever the definition cannot hold must be visible, not silently gone.
    expect(droppedLegacyFields([node], definition)).toEqual(expect.arrayContaining(legacyFields.filter(f => f !== 'role')));
  });

  test('L10: a plain node carries nothing, so nothing is reported', () => {
    const node = { id: 'a', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' } as unknown as NodeSpec;
    expect(droppedLegacyFields([node], liftDefinition([node]))).toEqual([]);
  });
});

/**
 * Issue #1 HB-312: a node that routes becomes a v2 router module.
 *
 * The interface has no `routes` field, so a routed node's routes were dropped with no
 * trace - the same failure `input` had. §13.4 already implements routers (each/once plus
 * rule expressions), so the mapping is a lift concern, not a missing capability.
 *
 *   L11 a routed node lifts to a router module, and the definition still parses
 *   L12 `when` becomes the router trigger; a node with no routes produces no module
 */
describe('a routed node becomes a router module (HB-312)', () => {
  const routed = (when?: string) => ([
    { id: 'work', kind: 'agent', action: 'work', definitionVersion: 'coder@1', model: 'm' },
    { id: 'gate', kind: 'agent', action: 'gate', definitionVersion: 'coder@1', model: 'm', dependsOn: ['work'],
      ...(when ? { when } : {}), routes: ['work', 'other'] },
  ] as unknown as NodeSpec[]);

  test('L11: the routes survive as a router module the real parser accepts', () => {
    const definition = liftDefinition(routed());
    expect(definition.modules['gate']).toMatchObject({ type: 'router' });
    expect(Object.keys(definition.modules['gate']!.outputs)).toHaveLength(2);
    // The whole definition must still be legal - a module that does not parse is worse
    // than no module at all.
    expect(() => parseGraphDefinition(definition)).not.toThrow();
  });

  test('L12: `when` becomes the trigger, and an unrouted node produces no module', () => {
    expect(liftDefinition(routed('once')).modules['gate']).toMatchObject({ trigger: 'once' });
    expect(liftDefinition(routed()).modules['gate']).toMatchObject({ trigger: 'each' });
    const plain = [{ id: 'a', kind: 'agent', action: 'a', definitionVersion: 'coder@1', model: 'm' }] as unknown as NodeSpec[];
    expect(liftDefinition(plain).modules).toEqual({});
  });
});
