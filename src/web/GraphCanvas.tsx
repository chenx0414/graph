import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, type EdgeProps, type NodeProps } from '@xyflow/react';
import { graphNodeLabel, graphNodeVisualKind, type GraphNodeVisualKind } from '../core/graph-presentation.ts';
import {
  BOARD_STATE_META,
  NODE_TONE_COLOR,
  boardNodeState,
  boardStateCounts,
  boardStateKnown,
  boardStateLabel,
  boardUnknownCount,
  nodeTone,
  type BoardNodeState,
  type NodeTone,
} from './insights.ts';

const GRID = 16;
const align = (value: number) => Math.round(value / GRID) * GRID;

type GraphPayload = {
  nodes: {
    id: string; kind: string; action?: string; status: string; container?: string; selectedModel?: string; instanceId?: string | null;
    context?: {
      purpose?: string;
      sourceNode?: string;
      requiredFacts?: { kind?: string }[];
      independence?: string;
      predecessors?: { source?: string; mode?: string }[];
    } | null;
  }[];
  containers: { id: string; parent?: string }[];
  layout: {
    positions: Record<string, { x: number; y: number; width: number; height: number }>;
    edges: { id: string; source: string; target: string; points?: { x: number; y: number }[] }[];
  };
};

type NodeData = {
  id: string;
  label: string;
  nodeType: GraphNodeVisualKind;
  tone: NodeTone;
  status: string;
  boardState: BoardNodeState;
  /** Status the four-state board did not recognise; shown with a visible 未知 badge. */
  unknown: boolean;
};

const NODE_TYPE_LABEL: Record<GraphNodeVisualKind, string> = {
  agent: 'A',
  tool: 'T',
  human: 'H',
  gate: 'G',
  route: 'R',
  join: 'J',
  program: 'P',
};

const handleStyle = { opacity: 0, width: 1, height: 1, border: 0, background: 'transparent' };

/** Node card with a status dot and the original "id status" text, so both the
 * screenshot reader and the UI tests keep working. */
function GraphNode({ data, selected }: NodeProps) {
  const info = data as unknown as NodeData;
  return (
    <div className="node-card" data-node-id={info.id} data-node-type={info.nodeType} data-status={info.status} data-tone={info.tone} data-board-state={info.boardState} data-selected={selected ? 'true' : 'false'}>
      <Handle id="target-top" type="target" position={Position.Top} style={handleStyle} />
      <Handle id="target-left" type="target" position={Position.Left} style={handleStyle} />
      <Handle id="target-right" type="target" position={Position.Right} style={handleStyle} />
      <div className="node-head">
        <span className="node-dot" style={{ background: NODE_TONE_COLOR[info.tone] }} />
        <span className="node-kind" title={info.nodeType}>{NODE_TYPE_LABEL[info.nodeType]}</span>
        <span
          className="node-state-icon"
          data-board-state={info.boardState}
          style={{ color: BOARD_STATE_META[info.boardState].color }}
          title={boardStateLabel(info.status)}
          aria-label={boardStateLabel(info.status)}
        >
          {BOARD_STATE_META[info.boardState].icon}
        </span>
        {info.unknown && <span className="node-unknown" data-unknown="true" title={boardStateLabel(info.status)}>未知</span>}
        <span className="node-label">{info.label}</span>
      </div>
      <Handle id="source-bottom" type="source" position={Position.Bottom} style={handleStyle} />
      <Handle id="source-left" type="source" position={Position.Left} style={handleStyle} />
      <Handle id="source-right" type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

const nodeTypes = { graphNode: GraphNode };

function GridEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth, data }: EdgeProps) {
  const points = (data as { points?: { x: number; y: number }[] } | undefined)?.points;
  const lane = (data as { lane?: number } | undefined)?.lane ?? 0;
  const path = points?.length
    ? `M ${points[0]!.x} ${points[0]!.y} ${points.slice(1).map(point => `L ${point.x} ${point.y}`).join(' ')}`
    : sourceX === targetX
    ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${sourceX} ${align((sourceY + targetY) / 2) + lane} L ${targetX} ${align((sourceY + targetY) / 2) + lane} L ${targetX} ${targetY}`;
  return <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} {...(interactionWidth !== undefined ? { interactionWidth } : {})} />;
}

function GridLoopEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth, data }: EdgeProps) {
  const explicitLeft = (data as { leftX?: number } | undefined)?.leftX;
  const lane = (data as { lane?: number } | undefined)?.lane
    ?? 40 + (id.split('').reduce((sum, value) => sum + value.charCodeAt(0), 0) % 3) * GRID;
  const left = explicitLeft ?? Math.min(sourceX, targetX) - lane;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${left} ${sourceY}`,
    `L ${left} ${targetY}`,
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
  const edgePolicy = new Map<string, string>();
  for (const node of graph.nodes) {
    for (const policy of node.context?.predecessors ?? []) {
      if (policy.source && policy.mode) edgePolicy.set(`${policy.source}:${node.id}`, policy.mode);
    }
  }
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
  const nodePositions = graph.nodes
    .map(node => graph.layout.positions[node.id])
    .filter((position): position is NonNullable<typeof position> => Boolean(position));
  const minNodeLeft = Math.min(0, ...nodePositions.map(position => position.x));
  let loopLane = 0;
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
      const nodeType = graphNodeVisualKind(node);
      return {
        id: node.id, type: 'graphNode', position: relativePosition(node.id, position),
        data: { id: node.id, label: graphNodeLabel(node), nodeType, tone, status: node.status, boardState: boardNodeState(node.status), unknown: !boardStateKnown(node.status) } satisfies NodeData,
        // Layout already knows the size; providing it keeps event-driven
        // remounts from waiting on a ResizeObserver measurement.
        measured: { width: position.width, height: position.height },
        style: { width: position.width, height: position.height },
        ...(node.container ? { parentId: node.container } : {}),
      };
    }),
  ];
  const edges = graph.layout.edges.filter(edge => !hidden.has(edge.source) && !hidden.has(edge.target))
    .map(edge => {
      const loop = edge.id.startsWith('loop:');
      const sourceIsNode = graph.nodes.some(node => node.id === edge.source);
      const targetIsNode = graph.nodes.some(node => node.id === edge.target);
      const policy = edgePolicy.get(`${edge.source}:${edge.target}`);
      const resultHandoff = policy === 'result_handoff';
      return {
        id: edge.id, source: edge.source, target: edge.target, type: loop ? 'gridLoop' : 'grid',
        ...(loop
          ? {
              ...(sourceIsNode ? { sourceHandle: 'source-left' } : {}),
              ...(targetIsNode ? { targetHandle: 'target-left' } : {}),
            }
          : {
              ...(sourceIsNode ? { sourceHandle: 'source-bottom' } : {}),
              ...(targetIsNode ? { targetHandle: 'target-top' } : {}),
            }),
        className: loop ? 'grid-edge grid-loop-edge' : 'grid-edge',
        ...(loop ? { data: { leftX: minNodeLeft - 64 - loopLane++ * 24 } } : {}),
        ...(!loop && edge.points?.length ? { data: { points: edge.points } } : {}),
        ...(policy ? {
          label: resultHandoff ? '结果交接' : '仅证据交接',
          labelStyle: { fill: resultHandoff ? '#b45309' : '#475569', fontSize: 11 },
          labelBgStyle: { fill: '#ffffff', fillOpacity: 0.92 },
          labelBgPadding: [4, 2] as [number, number],
          labelBgBorderRadius: 4,
        } : {}),
        ...(loop
          ? { animated: true, style: { stroke: '#d97706', strokeDasharray: '5 3' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#d97706' } }
          : { style: { stroke: resultHandoff ? '#d97706' : '#7c8aa5' }, markerEnd: { type: MarkerType.ArrowClosed, color: resultHandoff ? '#d97706' : '#7c8aa5' } }),
      };
    });
  // The four-state legend is rendered here so every view that draws a task
  // graph (task page and conversation drawer) shows the same permanent legend.
  const statuses = graph.nodes.map(node => node.status);
  const legend = boardStateCounts(statuses);
  const unknownCount = boardUnknownCount(statuses);
  return (
    <div className="graph-wrap" data-testid="flow">
      <ul className="graph-board-legend" data-testid="legend" aria-label="节点状态图例">
        {legend.map(item => (
          <li className="graph-board-legend-item" key={item.id} data-board-state={item.id}>
            <span className="graph-board-legend-icon" aria-hidden="true" style={{ color: item.color }}>{item.icon}</span>
            <span className="graph-board-legend-label">{item.label}</span>
            <span className="graph-board-legend-count" data-count={item.count}>{item.count}</span>
            {item.id === 'pending' && unknownCount > 0 && <span className="graph-board-legend-note" data-unknown="true">含未知 {unknownCount}</span>}
          </li>
        ))}
      </ul>
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
