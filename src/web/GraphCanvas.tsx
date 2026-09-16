import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, type EdgeProps, type NodeProps } from '@xyflow/react';
import { NODE_TONE_COLOR, nodeTone, type NodeTone } from './insights.ts';

const GRID = 16;
const align = (value: number) => Math.round(value / GRID) * GRID;

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

function GridEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth }: EdgeProps) {
  const path = sourceX === targetX
    ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${sourceX} ${align((sourceY + targetY) / 2)} L ${targetX} ${align((sourceY + targetY) / 2)} L ${targetX} ${targetY}`;
  return <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} {...(interactionWidth !== undefined ? { interactionWidth } : {})} />;
}

function GridLoopEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth }: EdgeProps) {
  const lane = 40 + (id.split('').reduce((sum, value) => sum + value.charCodeAt(0), 0) % 3) * GRID;
  const right = Math.max(sourceX, targetX) + lane;
  const entry = targetY - GRID;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${sourceX + GRID} ${sourceY}`,
    `L ${right} ${sourceY}`,
    `L ${right} ${entry}`,
    `L ${targetX} ${entry}`,
    `L ${targetX} ${targetY}`,
  ].join(' ');
  return <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} {...(interactionWidth !== undefined ? { interactionWidth } : {})} />;
}

const edgeTypes = { grid: GridEdge, gridLoop: GridLoopEdge };

export function GraphCanvas({ graph, collapsed, onSelect, selected }: {
  graph: GraphPayload;
  collapsed: Record<string, boolean>;
  onSelect: (id: string) => void;
  selected?: string | null;
}) {
  const containerById = new Map(graph.containers.map(container => [container.id, container]));
  const nodeContainer = new Map(graph.nodes.map(node => [node.id, node.container]));
  const relativePosition = (id: string, fallback: { x: number; y: number; width: number; height: number }) => {
    const position = graph.layout.positions[id] ?? fallback;
    const parentId = containerById.get(id)?.parent ?? nodeContainer.get(id);
    const parent = parentId ? graph.layout.positions[parentId] : undefined;
    return parent
      ? { x: position.x - parent.x, y: position.y - parent.y }
      : { x: position.x, y: position.y };
  };
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
        id: container.id, type: 'default', position: relativePosition(container.id, position),
        data: { label: `${container.id}` }, className: 'container-card',
        style: { width: position.width, height: position.height, zIndex: -1 },
        ...(container.parent ? { parentId: container.parent } : {}),
      };
    }),
    ...graph.nodes.filter(node => !hidden.has(node.id)).map(node => {
      const position = graph.layout.positions[node.id] ?? { x: 0, y: 0, width: 192, height: 48 };
      const tone = nodeTone(node.status);
      return {
        id: node.id, type: 'graphNode', position: relativePosition(node.id, position),
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
        id: edge.id, source: edge.source, target: edge.target, type: loop ? 'gridLoop' : 'grid',
        className: loop ? 'grid-edge grid-loop-edge' : 'grid-edge',
        ...(loop
          ? { animated: true, style: { stroke: '#d97706', strokeDasharray: '5 3' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#d97706' } }
          : { style: { stroke: '#7c8aa5' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#7c8aa5' } }),
      };
    });
  return (
    <div className="graph-wrap" data-testid="flow">
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false} nodesConnectable={false} elementsSelectable
        edgeTypes={edgeTypes}
        onNodeClick={(_event, node) => onSelect(node.id)} fitView fitViewOptions={{ padding: 0.18 }}
        snapToGrid snapGrid={[GRID, GRID]} proOptions={{ hideAttribution: false }}>
        <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.5} color="#b8c1cc" style={{ opacity: 0.52 }} />
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
