import ElkConstructor from 'elkjs';
import { orthogonalRoutes } from '../core/orthogonal-routes.ts';
import { graphNodeSize } from '../core/graph-presentation.ts';
type ElkNode = {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
};
type ElkEngine = { layout(graph: object): Promise<ElkNode> };
const elk: ElkEngine = new (ElkConstructor as unknown as { new(): ElkEngine })();
const GRID = 16;
const snap = (value: number) => Math.round(value / GRID) * GRID;
export type LayoutNode = { id: string; kind: string; action?: string; container?: string };
export type LayoutGroup = { id: string; parent?: string };
export type LayoutEdge = { id: string; source: string; target: string };

export type LayoutInput = { nodes: LayoutNode[]; containers?: LayoutGroup[]; edges: LayoutEdge[] };
export type LayoutPosition = { x: number; y: number; width: number; height: number };
export type GraphLayout = { positions: Record<string, LayoutPosition>; edges: (LayoutEdge & { points?: { x: number; y: number }[] })[] };

/** Preserve anchors; only new/reparented objects and neighbors displaced by growth are placed. */
function reusePositions(input: LayoutInput, positions: Record<string, LayoutPosition>, previous: { input: LayoutInput; layout: GraphLayout }) {
  const groups = input.containers ?? [];
  const parentMap = (value: LayoutInput) => new Map<string, string | undefined>([
    ...(value.containers ?? []).map(group => [group.id, group.parent] as const),
    ...value.nodes.map(node => [node.id, node.container] as const),
  ]);
  const parents = parentMap(input); const oldParents = parentMap(previous.input);
  const groupIds = new Set(groups.map(group => group.id));
  const oldGroups = new Set((previous.input.containers ?? []).map(group => group.id));
  const stable = new Set<string>();
  for (const id of parents.keys()) {
    let current: string | undefined = id; let unchanged = true;
    while (current !== undefined) {
      if (!oldParents.has(current) || parents.get(current) !== oldParents.get(current)
        || groupIds.has(current) !== oldGroups.has(current)) { unchanged = false; break; }
      current = parents.get(current);
    }
    if (unchanged && previous.layout.positions[id]) stable.add(id);
  }
  const original = Object.fromEntries(Object.entries(positions).map(([id, box]) => [id, { ...box }]));
  for (const id of parents.keys()) {
    if (stable.has(id)) {
      const old = previous.layout.positions[id]!;
      positions[id] = groupIds.has(id) ? { ...old } : { ...positions[id]!, x: old.x, y: old.y };
    } else {
      let ancestor = parents.get(id);
      while (ancestor && !stable.has(ancestor)) ancestor = parents.get(ancestor);
      if (ancestor) {
        positions[id]!.x += previous.layout.positions[ancestor]!.x - original[ancestor]!.x;
        positions[id]!.y += previous.layout.positions[ancestor]!.y - original[ancestor]!.y;
      }
    }
  }
  const children = (parent: string | undefined) => [...parents.keys()].filter(id => parents.get(id) === parent);
  const shift = (id: string, dx: number, dy: number) => {
    const descendants = [id];
    while (descendants.length) {
      const next = descendants.pop()!; positions[next]!.x += dx; positions[next]!.y += dy;
      descendants.push(...children(next));
    }
  };
  const incoming = new Map<string, number>(); const outgoing = new Map<string, number>();
  for (const edge of input.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, (outgoing.get(edge.source) ?? 0) + 1);
  }
  const footprint = (id: string) => {
    const box = positions[id]!;
    const top = groupIds.has(id) || !incoming.has(id) ? 0 : GRID * (incoming.get(id)! + 1);
    const bottom = groupIds.has(id) || !outgoing.has(id) ? 0 : GRID * (outgoing.get(id)! + 1);
    return { ...box, y: box.y - top, height: box.height + top + bottom, top };
  };
  const unchanged = (id: string) => {
    const box = positions[id]; const old = previous.layout.positions[id];
    return stable.has(id) && box && old && box.x === old.x && box.y === old.y && box.width === old.width && box.height === old.height;
  };
  const settle = (parent: string | undefined) => {
    const occupied: (ReturnType<typeof footprint> & { id: string })[] = [];
    // Growing existing groups retain their anchors; only the neighbors they reach move.
    const priority = (id: string) => (stable.has(id) ? 0 : 2) + (groupIds.has(id) ? 0 : 1);
    for (const id of children(parent).sort((a, b) => priority(a) - priority(b))) {
      const box = positions[id]!; const before = { ...box };
      if (parent && !stable.has(id)) { box.x = Math.max(box.x, positions[parent]!.x + 32); box.y = Math.max(box.y, positions[parent]!.y + 32); }
      while (true) {
        const area = footprint(id);
        const collisions = occupied.filter(other => !(unchanged(id) && unchanged(other.id))
          && area.x < other.x + other.width + 32 && area.x + area.width + 32 > other.x
          && area.y < other.y + other.height + 32 && area.y + area.height + 32 > other.y);
        if (!collisions.length) break;
        box.y = snap(Math.max(...collisions.map(other => other.y + other.height + 32 + area.top)));
      }
      const dx = box.x - before.x; const dy = box.y - before.y;
      box.x = before.x; box.y = before.y; shift(id, dx, dy);
      occupied.push({ ...footprint(id), id });
    }
    if (parent) {
      const box = positions[parent]!; const members = children(parent)
        .filter(id => !unchanged(id))
        .map(id => positions[id]!);
      box.width = Math.ceil(Math.max(box.width, ...members.map(child => child.x + child.width - box.x + 32)) / 32) * 32;
      box.height = Math.ceil(Math.max(box.height, ...members.map(child => child.y + child.height - box.y + 32)) / GRID) * GRID;
    }
  };
  const depth = (id: string) => { let count = 0; let current = parents.get(id); while (current) { count++; current = parents.get(current); } return count; };
  for (const group of [...groups].sort((a, b) => depth(b.id) - depth(a.id))) settle(group.id);
  settle(undefined);
  const boxes = [...parents.keys()].map(id => positions[id]!);
  positions.root = { x: 0, y: 0, width: Math.ceil(Math.max(160, ...boxes.map(box => box.x + box.width + 32)) / 32) * 32,
    height: Math.ceil(Math.max(64, ...boxes.map(box => box.y + box.height + 32)) / GRID) * GRID };
}

export async function layoutGraph(input: LayoutInput, previous?: { input: LayoutInput; layout: GraphLayout }): Promise<GraphLayout> {
  const containers = input.containers ?? [];
  const nested = new Set(input.nodes.filter(node => node.container).map(node => node.id));
  const byParent = new Map<string | undefined, string[]>();
  for (const container of containers) {
    const list = byParent.get(container.parent) ?? [];
    list.push(container.id);
    byParent.set(container.parent, list);
  }
  const box = (node: LayoutNode) => {
    const size = graphNodeSize(node);
    return { id: node.id, ...size, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' }, ports: [
      { id: `${node.id}:in`, x: size.width / 2, y: 0, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'NORTH' } },
      { id: `${node.id}:out`, x: size.width / 2, y: size.height, width: 0, height: 0, layoutOptions: { 'elk.port.side': 'SOUTH' } },
    ] };
  };
  const nodeChildren = (parent?: string) => input.nodes.filter(node => node.container === parent).map(box);
  const build = (id: string): { id: string; children: unknown[]; layoutOptions: Record<string, string> } => ({
    id,
    layoutOptions: { 'elk.padding': '[32,32,32,32]', 'elk.algorithm': 'layered', 'elk.direction': 'DOWN', 'elk.spacing.nodeNode': '64', 'elk.layered.spacing.nodeNodeBetweenLayers': layerSpacing },
    children: [
      ...(byParent.get(id) ?? []).map(build),
      ...nodeChildren(id),
    ],
  });
  const edges = input.edges.map(edge => ({ id: edge.id, sources: [edge.source], targets: [edge.target] }));
  const layerSpacing = String(64 + 32 * Math.max(1, ...input.nodes.map(node => Math.max(edges.filter(edge => edge.sources[0] === node.id).length, edges.filter(edge => edge.targets[0] === node.id).length))));
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '56',
      'elk.layered.spacing.nodeNodeBetweenLayers': layerSpacing,
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: [
      ...(byParent.get(undefined) ?? []).map(build),
      ...input.nodes.filter(node => !nested.has(node.id)).map(box),
    ],
    edges: edges.map(edge => ({ ...edge, sources: edge.sources.map(id => input.nodes.some(node => node.id === id) ? `${id}:out` : id), targets: edge.targets.map(id => input.nodes.some(node => node.id === id) ? `${id}:in` : id) })),
  };
  const laid = await elk.layout(graph as never);
  const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const walk = (node: ElkNode, ox = 0, oy = 0) => {
    if (!node.id) return;
    const x = snap(ox + (node.x ?? 0));
    const y = snap(oy + (node.y ?? 0));
    positions[node.id] = { x, y, width: Math.ceil((node.width ?? 160) / (GRID * 2)) * GRID * 2, height: Math.ceil((node.height ?? 64) / GRID) * GRID };
    for (const child of node.children ?? []) walk(child, x, y);
  };
  walk(laid);
  if (previous) reusePositions(input, positions, previous);
  const routed = orthogonalRoutes(input.edges, positions, input.nodes.map(node => node.id));
  return {
    positions,
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.sources[0]!,
      target: edge.targets[0]!,
      ...(routed.get(edge.id) ? { points: routed.get(edge.id)! } : {}),
    })),
  };
}
