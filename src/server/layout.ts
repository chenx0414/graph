import ElkConstructor from 'elkjs';
import type { ContainerSpec, LoopSpec, NodeSpec } from '../core/types.ts';

type ElkEngine = { layout(graph: object): Promise<{ id?: string; x?: number; y?: number; width?: number; height?: number; children?: object[] }> };
const elk: ElkEngine = new (ElkConstructor as unknown as { new(): ElkEngine })();
const GRID = 16;
const width = 192;
const height = 48;
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
    id: node.id, width, height, labels: [{ text: node.id }],
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
      'elk.layered.spacing.nodeNodeBetweenLayers': '48',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: [
      ...(byParent.get(undefined) ?? []).map(build),
      ...input.nodes.filter(node => !nested.has(node.id)).map(node => ({ id: node.id, width, height })),
    ],
    // Back-edges describe runtime rework, not dependency order. Including them
    // in the layered layout can invert the main path and collapse both edges
    // onto the same vertical lane.
    edges: dependencyEdges,
  };
  const laid = await elk.layout(graph as never);
  const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const walk = (node: { id?: string; x?: number; y?: number; width?: number; height?: number; children?: unknown[] }, ox = 0, oy = 0) => {
    if (!node.id) return;
    const x = snap(ox + (node.x ?? 0));
    const y = snap(oy + (node.y ?? 0));
    positions[node.id] = { x, y, width: node.width ?? width, height: node.height ?? height };
    for (const child of node.children ?? []) walk(child as typeof node, x, y);
  };
  walk(laid);
  return { positions, edges: edges.map(edge => ({ id: edge.id, source: edge.sources[0]!, target: edge.targets[0]! })) };
}
