import ElkConstructor from 'elkjs';
import { graphNodeSize } from '../core/graph-presentation.ts';
import { branchEdges } from '../core/branch-edges.ts';
import type { ContainerSpec, LoopSpec, NodeSpec } from '../core/types.ts';

type Point = { x: number; y: number };
type ElkSection = {
  startPoint?: Point;
  endPoint?: Point;
  bendPoints?: Point[];
};
type ElkEdge = {
  id?: string;
  sources?: string[];
  targets?: string[];
  container?: string;
  sections?: ElkSection[];
};
type ElkNode = {
  id?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  children?: ElkNode[];
  edges?: ElkEdge[];
};
type ElkEngine = { layout(graph: object): Promise<ElkNode> };
const elk: ElkEngine = new (ElkConstructor as unknown as { new(): ElkEngine })();
const GRID = 16;
const snap = (value: number) => Math.round(value / GRID) * GRID;

export async function layoutGraph(input: { nodes: NodeSpec[]; containers?: ContainerSpec[]; loops?: LoopSpec[] }) {
  const containers = input.containers ?? [];
  const nested = new Set(input.nodes.filter(node => node.container).map(node => node.id));
  const byParent = new Map<string | undefined, string[]>();
  for (const container of containers) {
    const list = byParent.get(container.parent) ?? [];
    list.push(container.id);
    byParent.set(container.parent, list);
  }
  const nodeChildren = (parent?: string) => input.nodes.filter(node => node.container === parent).map(node => ({
    id: node.id, ...graphNodeSize(node), labels: [{ text: node.id }],
  }));
  const build = (id: string): { id: string; children: unknown[]; layoutOptions: Record<string, string> } => ({
    id,
    layoutOptions: { 'elk.padding': '[32,32,32,32]', 'elk.algorithm': 'layered' },
    children: [
      ...(byParent.get(id) ?? []).map(build),
      ...nodeChildren(id),
    ],
  });
  const dependencyEdges = input.nodes.flatMap(node => (node.dependsOn ?? []).map((source, index) => ({ id: `${source}->${node.id}:${index}`, sources: [source], targets: [node.id] })));
  const loopEdges = (input.loops ?? []).map(loop => ({ id: `loop:${loop.from}->${loop.to}`, sources: [loop.from], targets: [loop.to] }));
  const edges = [
    ...dependencyEdges,
    ...loopEdges,
  ];
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.spacing.nodeNode': '56',
      'elk.layered.spacing.nodeNodeBetweenLayers': '72',
      'elk.layered.spacing.edgeNodeBetweenLayers': '28',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '20',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.mergeEdges': 'false',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: [
      ...(byParent.get(undefined) ?? []).map(build),
      ...input.nodes.filter(node => !nested.has(node.id)).map(node => ({ id: node.id, ...graphNodeSize(node) })),
    ],
    // Back-edges describe runtime rework, not dependency order. Including them
    // in the layered layout can invert the main path and collapse both edges
    // onto the same vertical lane.
    edges: dependencyEdges,
  };
  const laid = await elk.layout(graph as never);
  const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const origins: Record<string, Point> = {};
  const walk = (node: ElkNode, ox = 0, oy = 0) => {
    if (!node.id) return;
    const x = snap(ox + (node.x ?? 0));
    const y = snap(oy + (node.y ?? 0));
    origins[node.id] = { x, y };
    positions[node.id] = { x, y, width: node.width ?? 144, height: node.height ?? 56 };
    for (const child of node.children ?? []) walk(child, x, y);
  };
  walk(laid);
  const attachToBoundary = (point: Point, id: string | undefined) => {
    const rect = id ? positions[id] : undefined;
    if (!rect) return point;
    const x = Math.min(rect.x + rect.width, Math.max(rect.x, point.x));
    const y = Math.min(rect.y + rect.height, Math.max(rect.y, point.y));
    const candidates = [
      { x, y: rect.y },
      { x, y: rect.y + rect.height },
      { x: rect.x, y },
      { x: rect.x + rect.width, y },
    ];
    return candidates.reduce((best, candidate) => {
      const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
      const bestDistance = (best.x - point.x) ** 2 + (best.y - point.y) ** 2;
      return distance < bestDistance ? candidate : best;
    });
  };
  const routed = new Map<string, Point[]>();
  for (const edge of laid.edges ?? []) {
    if (!edge.id) continue;
    const section = edge.sections?.[0];
    if (!section?.startPoint || !section.endPoint) continue;
    const origin = origins[edge.container ?? 'root'] ?? { x: 0, y: 0 };
    const shift = (point: Point) => ({ x: Math.round(origin.x + point.x), y: Math.round(origin.y + point.y) });
    const points = [
      shift(section.startPoint),
      ...(section.bendPoints ?? []).map(shift),
      shift(section.endPoint),
    ];
    points[0] = attachToBoundary(points[0]!, edge.sources?.[0]);
    points[points.length - 1] = attachToBoundary(points[points.length - 1]!, edge.targets?.[0]);
    routed.set(edge.id, points);
  }
  return {
    positions,
    edges: edges.map(edge => ({
      id: edge.id,
      source: edge.sources[0]!,
      target: edge.targets[0]!,
      ...(routed.get(edge.id) ? { points: routed.get(edge.id)! } : {}),
    })),
    // Branch edges are not fed to ELK: like loops, they describe runtime choice rather than
    // dependency order, and letting them into the layered layout would bend the main path. They are
    // what makes "which case leads where" visible, which the picture did not show at all before.
    branches: branchEdges(input.nodes, containers, containerLeaves(input.nodes, containers)),
  };
}

/** A gated container is drawn by its members, so a branch entering the group names them. */
function containerLeaves(nodes: readonly NodeSpec[], containers: readonly ContainerSpec[]) {
  const leaves: Record<string, string[]> = {};
  const inside = (node: NodeSpec, containerId: string) => {
    let parent = node.container;
    while (parent) {
      if (parent === containerId) return true;
      parent = containers.find(container => container.id === parent)?.parent;
    }
    return false;
  };
  for (const container of containers) {
    if (!container.when) continue;
    leaves[container.id] = nodes.filter(node => inside(node, container.id)).map(node => node.id);
  }
  return leaves;
}
