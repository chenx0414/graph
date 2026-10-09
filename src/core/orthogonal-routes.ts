/** Route the formal edges on the same grid as the boxes, without changing graph semantics. */
type Point = { x: number; y: number };
type Rect = Point & { width: number; height: number };
type Edge = { id: string; source: string; target: string };
const GRID = 16;
const segmentKey = (a: Point, b: Point) => a.x < b.x || (a.x === b.x && a.y < b.y) ? `${a.x},${a.y}:${b.x},${b.y}` : `${b.x},${b.y}:${a.x},${a.y}`;
type Search = Point & { direction: number; cost: number; priority: number; previous?: Search };

class Frontier {
  private items: Search[] = [];
  push(item: Search) {
    this.items.push(item); let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.items[parent]!.priority <= item.priority) break;
      this.items[index] = this.items[parent]!; index = parent;
    }
    this.items[index] = item;
  }
  pop(): Search | undefined {
    const first = this.items[0]; const last = this.items.pop(); if (!first || !last || !this.items.length) return first;
    let index = 0;
    while (index * 2 + 1 < this.items.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.items.length && this.items[child + 1]!.priority < this.items[child]!.priority) child++;
      if (last.priority <= this.items[child]!.priority) break;
      this.items[index] = this.items[child]!; index = child;
    }
    this.items[index] = last; return first;
  }
}

export function orthogonalRoutes(edges: readonly Edge[], positions: Readonly<Record<string, Rect>>, nodeIds: readonly string[]) {
  // The caller supplies solid visible boxes. Expanded containers are transparent; folded groups are solid.
  const boxes = nodeIds.map(id => positions[id]!).filter(Boolean);
  const margin = GRID * (edges.length + 6);
  const bounds = { left: Math.min(0, ...boxes.map(box => box.x)) - margin, right: Math.max(0, ...boxes.map(box => box.x + box.width)) + margin,
    top: Math.min(0, ...boxes.map(box => box.y)) - margin, bottom: Math.max(0, ...boxes.map(box => box.y + box.height)) + margin };
  const blocked = (point: Point) => boxes.some(box => point.x > box.x - GRID && point.x < box.x + box.width + GRID && point.y > box.y - GRID && point.y < box.y + box.height + GRID);
  const reserved = new Set<string>(); const result = new Map<string, Point[]>();
  const outgoing = new Map<string, number>(); const incoming = new Map<string, number>();
  const walk = (start: Point, end: Point): Point[] => {
    const frontier = new Frontier(); const best = new Map<string, number>();
    const heuristic = (point: Point) => (Math.abs(point.x - end.x) + Math.abs(point.y - end.y)) / GRID;
    frontier.push({ ...start, direction: -1, cost: 0, priority: heuristic(start) });
    while (true) {
      const current = frontier.pop(); if (!current) throw new Error('No orthogonal route between graph connectors');
      const key = `${current.x},${current.y},${current.direction}`;
      if (current.cost > (best.get(key) ?? Infinity)) continue;
      if (current.x === end.x && current.y === end.y) {
        const path: Point[] = []; let step: Search | undefined = current;
        while (step) { path.push({ x: step.x, y: step.y }); step = step.previous; }
        return path.reverse();
      }
      for (const [dx, dy, direction] of [[0, GRID, 0], [-GRID, 0, 1], [GRID, 0, 1], [0, -GRID, 0]] as const) {
        const next = { x: current.x + dx, y: current.y + dy };
        if (next.x < bounds.left || next.x > bounds.right || next.y < bounds.top || next.y > bounds.bottom || blocked(next) || reserved.has(segmentKey(current, next))) continue;
        const cost = current.cost + 1 + (current.direction !== -1 && current.direction !== direction ? 0.5 : 0);
        const nextKey = `${next.x},${next.y},${direction}`; if (cost >= (best.get(nextKey) ?? Infinity)) continue;
        best.set(nextKey, cost); frontier.push({ ...next, direction, cost, priority: cost + heuristic(next), previous: current });
      }
    }
  };
  const remember = (points: Point[]) => {
    for (let index = 1; index < points.length; index++) reserved.add(segmentKey(points[index - 1]!, points[index]!));
  };
  const simplify = (points: Point[]) => points.filter((point, index) => {
    const before = points[index - 1]; const after = points[index + 1];
    return !before || !after || !((before.x === point.x && point.x === after.x) || (before.y === point.y && point.y === after.y));
  });
  const prepared = edges.map(edge => {
    const source = positions[edge.source]; const target = positions[edge.target];
    if (!source || !target) throw new Error(`Missing layout endpoint for ${edge.id}`);
    const out = outgoing.get(edge.source) ?? 0; outgoing.set(edge.source, out + 1);
    const into = incoming.get(edge.target) ?? 0; incoming.set(edge.target, into + 1);
    const start = { x: source.x + source.width / 2, y: source.y + source.height };
    const end = { x: target.x + target.width / 2, y: target.y };
    const leave = { x: start.x, y: start.y + GRID * (2 + out) }; const arrive = { x: end.x, y: end.y - GRID * (2 + into) };
    const stem = (a: Point, b: Point) => {
      const points = [a]; const dy = a.y < b.y ? GRID : -GRID;
      for (let y = a.y + dy; y !== b.y + dy; y += dy) points.push({ x: a.x, y });
      return points;
    };
    const sourceStem = stem(start, leave); const targetStem = stem(arrive, end);
    for (const point of [...sourceStem.slice(1), ...targetStem.slice(0, -1)]) if (boxes.some(box => point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height)) throw new Error(`Connector stem crosses a node for ${edge.id}`);
    remember(sourceStem); remember(targetStem);
    return { edge, start, end, leave, arrive };
  });
  for (const { edge, start, end, leave, arrive } of prepared) {
    const path = walk(leave, arrive); remember(path);
    // Keep the stem boundaries even when collinear so callers can distinguish shared connectors from lanes.
    result.set(edge.id, [start, ...simplify(path), end]);
  }
  return result;
}
