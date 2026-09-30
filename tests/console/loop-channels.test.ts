import { expect, test } from 'vitest';
import { loopChannels } from '../../src/web/graph-edges.ts';

/**
 * Rework back-edges used to all route up the far left of the whole picture, 24px apart, so three
 * lanes drew three arcs stacked on each other and each one crossed the lanes in between. The rule is
 * now "a loop leaves on its own lane's near side": same-lane loops still separate, but different
 * lanes never share a channel and never travel to the global gutter unless the lane is the leftmost.
 */

type Rect = { x: number; y: number; width: number; height: number };
const rect = (x: number, y: number): Rect => ({ x, y, width: 192, height: 48 });

test('three side-by-side lanes get three distinct channels, each beside its own lane', () => {
  // impl row on top, gate row below: one loop per lane (gate -> impl of the same lane).
  const positions: Record<string, Rect> = {
    'impl-a': rect(0, 0), 'impl-b': rect(300, 0), 'impl-c': rect(600, 0),
    'gate-a': rect(0, 200), 'gate-b': rect(300, 200), 'gate-c': rect(600, 200),
  };
  const loops = [
    { id: 'loop:gate-a->impl-a', source: 'gate-a', target: 'impl-a' },
    { id: 'loop:gate-b->impl-b', source: 'gate-b', target: 'impl-b' },
    { id: 'loop:gate-c->impl-c', source: 'gate-c', target: 'impl-c' },
  ];
  const channels = loopChannels(loops, positions);
  const a = channels['loop:gate-a->impl-a']!;
  const b = channels['loop:gate-b->impl-b']!;
  const c = channels['loop:gate-c->impl-c']!;

  // Distinct channels: no two arcs share a line.
  expect(new Set([a, b, c]).size).toBe(3);
  // Each channel sits left of its own lane's left edge.
  expect(a).toBeLessThan(0);
  expect(b).toBeLessThan(300);
  expect(c).toBeLessThan(600);
  // A non-leftmost lane must NOT travel to the global gutter: it stays beside its own lane,
  // strictly right of the leftmost lane's channel.
  expect(b).toBeGreaterThan(a);
  expect(c).toBeGreaterThan(b);
  // And it must stay in the gap of its own lane, not wander across a neighbour's column.
  expect(b).toBeGreaterThan(192);
  expect(c).toBeGreaterThan(492);
});

test('the leftmost lane still uses the left gutter', () => {
  const positions: Record<string, Rect> = { 'impl-a': rect(0, 0), 'gate-a': rect(0, 200) };
  const channels = loopChannels([{ id: 'loop:gate-a->impl-a', source: 'gate-a', target: 'impl-a' }], positions);
  expect(channels['loop:gate-a->impl-a']).toBeLessThanOrEqual(-64);
});

test('two loops in the same lane separate instead of stacking on one line', () => {
  const positions: Record<string, Rect> = {
    'impl-a': rect(0, 0), 'gate-a': rect(0, 200), 'gate-a2': rect(0, 260),
  };
  const channels = loopChannels([
    { id: 'loop:gate-a->impl-a', source: 'gate-a', target: 'impl-a' },
    { id: 'loop:gate-a2->impl-a', source: 'gate-a2', target: 'impl-a' },
  ], positions);
  const first = channels['loop:gate-a->impl-a']!;
  const second = channels['loop:gate-a2->impl-a']!;
  expect(second).not.toBe(first);
  expect(Math.abs(second - first)).toBeGreaterThanOrEqual(16);
});
