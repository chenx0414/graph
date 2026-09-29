/**
 * Where a rework back-edge's vertical run goes.
 *
 * `layoutGraph` keeps loops out of ELK on purpose (they describe runtime rework, not dependency
 * order), so the canvas has to invent their path. It used to give every loop the same far-left
 * gutter with a 24px lane offset, which meant that with lanes side by side each back-edge travelled
 * across every lane in between and the arcs stacked on one another.
 *
 * The rule here is "a loop leaves on its own lane's near side": the channel sits just left of the
 * loop's own column, so the two horizontal runs never span another lane. Loops that share a column
 * (unusual, but possible) still separate by a fixed step, and the leftmost lane keeps the left
 * gutter so the single-lane picture is unchanged.
 */

type Rect = { x: number; y: number; width: number; height: number };
/** One layout edge: the canvas id plus the node ids it runs between. */
export type LoopGeometry = { id: string; source: string; target: string };

/** Gap between a lane's left edge and its own channel. */
const LANE_GAP = 40;
/** Separation between two loops that share a lane. */
const SAME_LANE_STEP = 22;
/** Per-loop step used only to keep the leftmost lane from stacking against itself. */
const GUTTER_STEP = 24;
/** How far left of the graph the gutter starts. */
const GUTTER_OFFSET = 64;

/** The x each loop's vertical run uses, keyed by the loop edge id. */
export function loopChannels(
  loops: readonly LoopGeometry[],
  positions: Readonly<Record<string, Rect | undefined>>,
): Record<string, number> {
  const rects = Object.values(positions).filter((rect): rect is Rect => Boolean(rect));
  const graphLeft = Math.min(0, ...rects.map(rect => rect.x));
  const gutter = graphLeft - GUTTER_OFFSET;

  const laneOf = (loop: LoopGeometry): number | null => {
    const ends = [positions[loop.source], positions[loop.target]].filter((rect): rect is Rect => Boolean(rect));
    return ends.length ? Math.min(...ends.map(rect => rect.x)) : null;
  };

  const perLane = new Map<number, number>();
  const channels: Record<string, number> = {};
  for (const loop of loops) {
    const lane = laneOf(loop);
    if (lane === null) continue;
    const seen = perLane.get(lane) ?? 0;
    perLane.set(lane, seen + 1);
    // A lane that already sits at the graph's left edge has no room beside it: use the gutter there,
    // and let the gutter step keep several such loops apart.
    const channel = lane <= graphLeft
      ? Math.min(lane - LANE_GAP, gutter - seen * GUTTER_STEP)
      : lane - LANE_GAP - seen * SAME_LANE_STEP;
    channels[loop.id] = channel;
  }
  return channels;
}
