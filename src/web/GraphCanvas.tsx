import { ReactFlow, Background, Controls } from '@xyflow/react';

type GraphPayload = {
  nodes: { id: string; kind: string; status: string; container?: string }[];
  containers: { id: string; parent?: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
};

export function GraphCanvas({ graph, collapsed, onSelect }: { graph: GraphPayload; collapsed: Record<string, boolean>; onSelect: (id: string) => void }) {
  const hiddenContainers = new Set<string>();
  const walk = (id: string) => {
    hiddenContainers.add(id);
    for (const container of graph.containers) if (container.parent === id) walk(container.id);
  };
  for (const [id, closed] of Object.entries(collapsed)) if (closed) walk(id);
  const hidden = new Set(graph.nodes.filter(node => node.container && hiddenContainers.has(node.container)).map(node => node.id));
  const nodes = [
    ...graph.containers.map(container => {
      const position = graph.layout.positions[container.id] ?? { x: 0, y: 0, width: 240, height: 120 };
      return {
        id: container.id, position: { x: position.x, y: position.y },
        data: { label: container.id },
        style: { width: position.width, height: position.height, background: 'transparent' },
        ...(container.parent ? { parentId: container.parent } : {}),
      };
    }),
    ...graph.nodes.filter(node => !hidden.has(node.id)).map(node => {
      const position = graph.layout.positions[node.id] ?? { x: 0, y: 0, width: 180, height: 48 };
      return {
        id: node.id, position: { x: position.x, y: position.y },
        data: { label: `${node.id} ${node.status}` },
        style: { width: position.width, height: position.height, minWidth: 120, minHeight: 36 },
        ...(node.container ? { parentId: node.container } : {}),
      };
    }),
  ];
  const edges = graph.layout.edges.filter(edge => !hidden.has(edge.source) && !hidden.has(edge.target))
    .map(edge => ({ id: edge.id, source: edge.source, target: edge.target }));
  return (
    <div style={{ height: 480 }} data-testid="flow">
      <ReactFlow nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false} elementsSelectable
        onNodeClick={(_event, node) => onSelect(node.id)} fitView>
        <Background />
        <Controls />
      </ReactFlow>
    </div>
  );
}
