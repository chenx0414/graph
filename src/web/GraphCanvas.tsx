import { ReactFlow, Background, Controls, Handle, MarkerType, MiniMap, Position, type NodeProps } from '@xyflow/react';
import { NODE_TONE_COLOR, nodeTone, type NodeTone } from './insights.ts';

type GraphPayload = {
  nodes: { id: string; kind: string; status: string; container?: string; selectedModel?: string; instanceId?: string | null }[];
  containers: { id: string; parent?: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[] };
};

type NodeData = { label: string; tone: NodeTone };

/** Node card with a status dot and the original "id status" text, so both the
 * screenshot reader and the UI tests keep working. */
function GraphNode({ data, selected }: NodeProps) {
  const info = data as unknown as NodeData;
  return (
    <div className="node-card" data-tone={info.tone} data-selected={selected ? 'true' : 'false'}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0, width: 1, height: 1 }} />
      <div className="node-head">
        <span className="node-dot" style={{ background: NODE_TONE_COLOR[info.tone] }} />
        {info.label}
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0, width: 1, height: 1 }} />
    </div>
  );
}

const nodeTypes = { graphNode: GraphNode };

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
        id: container.id, type: 'default', position: { x: position.x, y: position.y },
        data: { label: `${container.id}` }, className: 'container-card',
        style: { width: position.width, height: position.height, zIndex: -1 },
        ...(container.parent ? { parentId: container.parent } : {}),
      };
    }),
    ...graph.nodes.filter(node => !hidden.has(node.id)).map(node => {
      const position = graph.layout.positions[node.id] ?? { x: 0, y: 0, width: 180, height: 48 };
      const tone = nodeTone(node.status);
      return {
        id: node.id, type: 'graphNode', position: { x: position.x, y: position.y },
        data: { label: `${node.id} ${node.status}`, tone } satisfies NodeData,
        // Layout already knows the size; providing it keeps event-driven
        // remounts from waiting on a ResizeObserver measurement.
        measured: { width: position.width, height: position.height },
        style: { width: position.width, height: position.height, minWidth: 150, minHeight: 44 },
        ...(node.container ? { parentId: node.container } : {}),
      };
    }),
  ];
  const edges = graph.layout.edges.filter(edge => !hidden.has(edge.source) && !hidden.has(edge.target))
    .map(edge => {
      const loop = edge.id.startsWith('loop:');
      return {
        id: edge.id, source: edge.source, target: edge.target,
        ...(loop
          ? { animated: true, style: { stroke: '#d97706', strokeDasharray: '5 3' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#d97706' } }
          : { style: { stroke: '#7c8aa5' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#7c8aa5' } }),
      };
    });
  return (
    <div className="graph-wrap" data-testid="flow">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable
        onNodeClick={(_event, node) => onSelect(node.id)} fitView proOptions={{ hideAttribution: false }}>
        <Background gap={18} size={1.4} color="#94a3b8" style={{ opacity: 0.25 }} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          maskColor="rgba(100,116,139,0.12)"
          nodeColor={node => {
            const info = node.data as unknown as NodeData;
            return info.tone ? NODE_TONE_COLOR[info.tone] : 'transparent';
          }}
        />
      </ReactFlow>
    </div>
  );
}
