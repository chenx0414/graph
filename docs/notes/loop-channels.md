**Loop channels**

The rule for where a rework back-edge runs lives in `src/web/graph-edges.ts` (`loopChannels`):

- Each loop's vertical channel sits just left of its own lane. Two horizontal runs therefore never
  span another lane, and lanes side by side no longer stack their return arcs on the far-left gutter.
- The leftmost lane keeps the old global gutter (`≤ -64`) so a single-lane graph renders unchanged.
- Loops sharing a lane separate by a fixed step.
- `src/web/GraphCanvas.tsx` reads the rule; `tests/console/loop-channels.test.ts` pins it.
