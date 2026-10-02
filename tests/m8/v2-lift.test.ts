import { describe, expect, test } from 'vitest';
import { parseGraphDefinition } from '../../src/core/interface-spec.ts';
import type { NodeSpec } from '../../src/core/types.ts';
import { liftDefinition, withLiftedDefinition } from '../fixtures/v2-lift.ts';

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