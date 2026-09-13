import { ReactFlow, Background, Controls, MarkerType, MiniMap } from '@xyflow/react';
import { NODE_TONE_COLOR, nodeTone } from './insights.ts';

type GraphPayload = {
  nodes: { id: string; kind: string; status: string; container?: string; selectedModel?: string; instanceId?: string | null }[];
  containers: { id: string; parent?: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
};

export function GraphCanvas({ graph, collapsed, onSelect, selected }: {
  graph: GraphPayload;
  collapsed: Record<string, boolean>;
  onSelect: (id: string) => void;
  selected?: string | null;
}) {
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
      const selectedStyle = selected === node.id ? { border: '2px solid #2563eb', boxShadow: '0 0 0 2px rgba(37,99,235,0.2)' } : {};
      const tone = NODE_TONE_COLOR[nodeTone(node.status)];
      return {
        id: node.id, position: { x: position.x, y: position.y },
        data: { label: `${node.id} ${node.status}` },
        // Layout already knows the size; providing it keeps event-driven
        // remounts from waiting on a ResizeObserver measurement.
        measured: { width: position.width, height: position.height },
        style: { width: position.width, height: position.height, minWidth: 120, minHeight: 36, border: `2px solid ${tone}`, ...selectedStyle },
        ...(node.container ? { parentId: node.container } : {}),
      };
    }),
  ];
  const edges = graph.layout.edges.filter(edge => !hidden.has(edge.source) && !hidden.has(edge.target))
    .map(edge => {
      const loop = edge.id.startsWith('loop:');
      return {
        id: edge.id, source: edge.source, target: edge.target,
        ...(loop ? { animated: true, style: { stroke: '#d97706', strokeDasharray: '5 3' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#d97706' } } : {}),
      };
    });
  return (
    <div style={{ height: 480 }} data-testid="flow">
      <ReactFlow nodes={nodes} edges={edges} nodesDraggable={false} nodesConnectable={false} elementsSelectable
        onNodeClick={(_event, node) => onSelect(node.id)} fitView>
        <Background />
        <Controls />
        <MiniMap
          pannable
          zoomable
          nodeColor={node => {
            const status = (node.data as { label?: string }).label?.split(' ').pop();
            return status ? NODE_TONE_COLOR[nodeTone(status)] : 'transparent';
          }}
        />
      </ReactFlow>
    </div>
  );
}
