import ElkConstructor from 'elkjs';
import type { ContainerSpec, LoopSpec, NodeSpec } from '../core/types.ts';

type ElkEngine = { layout(graph: object): Promise<{ id?: string; x?: number; y?: number; width?: number; height?: number; children?: object[] }> };
const elk: ElkEngine = new (ElkConstructor as unknown as { new(): ElkEngine })();
const width = 180;
const height = 48;

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
    layoutOptions: { 'elk.padding': '[24,24,24,24]', 'elk.algorithm': 'layered' },
    children: [
      ...(byParent.get(id) ?? []).map(build),
      ...nodeChildren(id),
    ],
  });
  const edges = [
    ...input.nodes.flatMap(node => (node.dependsOn ?? []).map((source, index) => ({ id: `${source}->${node.id}:${index}`, sources: [source], targets: [node.id] }))),
    ...(input.loops ?? []).map(loop => ({ id: `loop:${loop.from}->${loop.to}`, sources: [loop.from], targets: [loop.to] })),
  ];
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.hierarchyHandling': 'INCLUDE_CHILDREN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '40',
    },
    children: [
      ...(byParent.get(undefined) ?? []).map(build),
      ...input.nodes.filter(node => !nested.has(node.id)).map(node => ({ id: node.id, width, height })),
    ],
    edges,
  };
  const laid = await elk.layout(graph as never);
  const positions: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const walk = (node: { id?: string; x?: number; y?: number; width?: number; height?: number; children?: unknown[] }, ox = 0, oy = 0) => {
    if (!node.id) return;
    const x = ox + (node.x ?? 0);
    const y = oy + (node.y ?? 0);
    positions[node.id] = { x, y, width: node.width ?? width, height: node.height ?? height };
    for (const child of node.children ?? []) walk(child as typeof node, x, y);
  };
  walk(laid);
  return { positions, edges: edges.map(edge => ({ id: edge.id, source: edge.sources[0]!, target: edge.targets[0]! })) };
}
