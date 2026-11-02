// graph:allow-large-file: its 27 KB predate the budget; this change only re-points one type import
import type { GraphIo, GraphOutput } from '../core/interface-spec.ts';
import type { ModuleExplanation } from './kernel-view-types.ts';
import { api } from './api.ts';
import { useEffect, useState } from 'react';
import { ReactFlow, Background, BackgroundVariant, BaseEdge, Controls, Handle, MarkerType, MiniMap, Position, type Edge, type EdgeProps, type NodeProps } from '@xyflow/react';
import { useFoldedRoutes } from './folded-routes.ts';
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
  interfaces?: { edgeId: string; from: string; to: string; enabled: boolean; protocol: string | null; latest: unknown; nextBefore?: number | null; deliveries: { id: string; value: unknown; seq?: number; valueTruncated?: boolean; valueBytes?: number; valuePreview?: string | null; protocol: string; revisionVersion: number; createdAt: number; source?: string; sourceExecutionId?: string | null; artifacts?: { taskId: string; artifactId: string; version: number; digest: string | null }[]; receiver?: { kind: string; state: string; operationId: string | null; reason: string | null } }[] }[];
  modules?: (ModuleExplanation & { definition?: { rules?: unknown[] } })[];
  messages?: { id: string; source: string; target: string; text: string; createdAt: number }[];
  nodes: {
    id: string; kind: string; action?: string; status: string; container?: string; selectedModel?: string; instanceId?: string | null;
    label: string; visualKind: string;
  }[];
  containers: { id: string; parent?: string; template?: string; version?: number; inputs?: Record<string, GraphIo>; outputs?: Record<string, GraphOutput> }[];
  layout: {
    positions: Record<string, { x: number; y: number; width: number; height: number }>;
    edges: { id: string; source: string; target: string; points?: { x: number; y: number }[] }[];
  };
};

type NodeData = {
  id: string;
  label: string;
  nodeType: string;
  tone: NodeTone;
  status: string;
  boardState: BoardNodeState;
  /** Status the four-state board did not recognise; shown with a visible 未知 badge. */
  unknown: boolean;
};

const NODE_TYPE_LABEL: Record<string, string> = {
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
      <Handle id="source-right" type="source" position={Position.Right} style={handleStyle} />
    </div>
  );
}

function GraphContainer({ data }: NodeProps) {
  const group = data as unknown as GraphPayload['containers'][number] & { label: string; collapsed: boolean };
  return <>
    <Handle id="target-top" type="target" position={Position.Top} style={handleStyle} />
    <Handle id="target-left" type="target" position={Position.Left} style={handleStyle} />
    <span>{group.label} {group.template && <small>{group.template}@{group.version}</small>}</span>
    {group.collapsed && <div className="subgraph-ports" data-testid={`subgraph-ports-${group.id}`}>
      <strong>输入</strong>
      {Object.entries(group.inputs ?? {}).map(([name, port]) => <div key={`in:${name}`} title={`传入 ${port.to}`}><code>{name}</code> · {port.protocol}@{port.version ?? 1} → {port.to}</div>)}
      {!Object.keys(group.inputs ?? {}).length && <div>无公开输入</div>}
      <strong>输出</strong>
      {Object.entries(group.outputs ?? {}).map(([name, port]) => <div key={`out:${name}`} title={`传出 ${port.from}`}><code>{name}</code> · {port.protocol}@{port.version ?? 1} ← {port.from}</div>)}
      {!Object.keys(group.outputs ?? {}).length && <div>无公开输出</div>}
    </div>}
    <Handle id="source-bottom" type="source" position={Position.Bottom} style={handleStyle} />
    <Handle id="source-right" type="source" position={Position.Right} style={handleStyle} />
  </>;
}

const nodeTypes = { graphNode: GraphNode, graphContainer: GraphContainer };

/**
 * The label an edge carries, drawn at its midpoint.
 *
 * React Flow only renders `label` for its built-in edges; these edges are custom, so a label passed
 * in options was silently dropped — which is how the existing "结果交接" text never appeared either.
 * Drawing it here keeps named interface connections and peer messages readable.
 */
function EdgeLabel({ text, x, y, color }: { text: string; x: number; y: number; color: string }) {
  const width = text.length * 6.2 + 10;
  return (
    <g transform={`translate(${x - width / 2}, ${y - 9})`}>
      <rect width={width} height={18} rx={4} fill="#ffffff" fillOpacity={0.92} />
      <text x={width / 2} y={12.5} textAnchor="middle" fontSize={11} fill={color}>{text}</text>
    </g>
  );
}

function GridEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth, data }: EdgeProps) {
  const points = (data as { points?: { x: number; y: number }[] } | undefined)?.points;
  const lane = (data as { lane?: number } | undefined)?.lane ?? 0;
  const label = (data as { edgeLabel?: string } | undefined)?.edgeLabel;
  const labelColor = (data as { edgeLabelColor?: string } | undefined)?.edgeLabelColor ?? '#475569';
  const midX = points?.length ? points[Math.floor(points.length / 2)]!.x : (sourceX + targetX) / 2;
  const midY = points?.length ? points[Math.floor(points.length / 2)]!.y : (sourceY + targetY) / 2 + lane;
  const path = points?.length
    ? `M ${points[0]!.x} ${points[0]!.y} ${points.slice(1).map(point => `L ${point.x} ${point.y}`).join(' ')}`
    : sourceX === targetX
    ? `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`
    : `M ${sourceX} ${sourceY} L ${sourceX} ${align((sourceY + targetY) / 2) + lane} L ${targetX} ${align((sourceY + targetY) / 2) + lane} L ${targetX} ${targetY}`;
  return (
    <>
      <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} {...(interactionWidth !== undefined ? { interactionWidth } : {})} />
      {label ? <EdgeLabel text={label} x={midX} y={midY} color={labelColor} /> : null}
    </>
  );
}

function MessageEdge({ id, sourceX, sourceY, targetX, targetY, markerEnd, style, interactionWidth, data }: EdgeProps) {
  const bend = Math.max(70, Math.abs(targetX - sourceX) * 0.35);
  const path = `M ${sourceX} ${sourceY} C ${sourceX + bend} ${sourceY - 48}, ${targetX - bend} ${targetY - 48}, ${targetX} ${targetY}`;
  return <>
    <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} {...(style ? { style } : {})} {...(interactionWidth !== undefined ? { interactionWidth } : {})} />
    <EdgeLabel text={String((data as { edgeLabel?: string } | undefined)?.edgeLabel ?? '消息')} x={(sourceX + targetX) / 2} y={(sourceY + targetY) / 2 - 36} color="#6366f1" />
  </>;
}

const edgeTypes = { grid: GridEdge, message: MessageEdge };

type InterfaceView = NonNullable<GraphPayload['interfaces']>[number];

function EdgeHistory({ taskId, summary }: { taskId: string | null; summary: InterfaceView }) {
  const [page, setPage] = useState(summary);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [loadingValue, setLoadingValue] = useState<string | null>(null);
  const path = taskId ? `/api/tasks/${encodeURIComponent(taskId)}/graph/edges/${encodeURIComponent(summary.edgeId)}` : null;
  const newest = summary.deliveries[0];
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setLoading(true); setError('');
    void api<InterfaceView>(`${path}?limit=20`, { signal: controller.signal }).then(setPage)
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, newest?.id, newest?.receiver?.state]);
  async function more() {
    if (!path || !page.nextBefore || loading) return;
    setLoading(true); setError('');
    try {
      const next = await api<InterfaceView>(`${path}?before=${page.nextBefore}&limit=20`);
      setPage(current => ({ ...current, nextBefore: next.nextBefore ?? null,
        deliveries: [...current.deliveries, ...next.deliveries.filter(item => !current.deliveries.some(known => known.id === item.id))] }));
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }
  async function fullValue(id: string) {
    if (!path || loadingValue) return;
    setLoadingValue(id); setError('');
    try {
      const delivery = await api<InterfaceView['deliveries'][number]>(`${path}/deliveries/${encodeURIComponent(id)}`);
      setPage(current => ({ ...current, deliveries: current.deliveries.map(item => item.id === id ? delivery : item) }));
    } catch (reason) { setError(String(reason)); }
    finally { setLoadingValue(null); }
  }
  return <>
    {error && <p role="alert">{error}</p>}
    {loading && <p>正在读取投递历史…</p>}
    {page.deliveries.length ? <ol>{page.deliveries.map(delivery => <li key={delivery.id}>
      <time>{new Date(delivery.createdAt).toLocaleString()} · v{delivery.revisionVersion}</time>
      <p>来源：{delivery.source ?? '未记录'} · 执行：{delivery.sourceExecutionId ?? '无 agent 执行'}</p>
      <p>接收状态：{delivery.receiver?.state ?? '未记录'}{delivery.receiver?.operationId ? ` · ${delivery.receiver.operationId}` : ''}</p>
      {delivery.receiver?.reason && <p>{delivery.receiver.reason}</p>}
      {delivery.artifacts?.map(artifact => <p key={`${artifact.artifactId}:${artifact.version}`}>
        <a href={`#/tasks/${encodeURIComponent(artifact.taskId)}/artifacts/${encodeURIComponent(artifact.artifactId)}?v=${artifact.version}`}>产物 {artifact.artifactId} · v{artifact.version}</a>
        {artifact.digest && <span className="mono"> · {artifact.digest}</span>}
      </p>)}
      {delivery.valueTruncated ? <>
        <p>value 尚未完整加载 · {delivery.valueBytes} bytes</p><pre>{delivery.valuePreview}</pre>
        {path && <button type="button" disabled={loadingValue !== null} onClick={() => void fullValue(delivery.id)}>读取完整 value</button>}
      </> : <pre>{JSON.stringify(delivery.value, null, 2)}</pre>}
    </li>)}</ol> : !loading && <p>尚无投递</p>}
    {page.nextBefore && path && <button type="button" disabled={loading} onClick={() => void more()}>加载更早投递</button>}
  </>;
}

type ModuleView = NonNullable<GraphPayload['modules']>[number];

function ModuleHistory({ taskId, summary, onReopen }: { taskId: string | null; summary: ModuleView; onReopen?: (id: string) => void }) {
  const [page, setPage] = useState(summary);
  const [loading, setLoading] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [error, setError] = useState('');
  const inputsRevision = JSON.stringify(summary.inputs);
  const path = taskId ? `/api/tasks/${encodeURIComponent(taskId)}/graph/modules/${encodeURIComponent(summary.moduleId)}` : null;
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController(); setLoading(true); setError('');
    void api<ModuleView>(`${path}?limit=20`, { signal: controller.signal }).then(result => setPage({ ...summary, ...result }))
      .catch(reason => { if (!controller.signal.aborted) setError(String(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [path, summary.latestTransition, summary.ruleVersion, summary.triggered, inputsRevision]);
  async function more() {
    if (!path || !page.nextAfter || loading) return;
    setLoading(true); setError('');
    try {
      const result = await api<ModuleView>(`${path}?after=${page.nextAfter}&limit=20`);
      setPage(current => ({ ...current, nextAfter: result.nextAfter,
        transitions: [...current.transitions, ...result.transitions.filter(item => !current.transitions.some(known => known.id === item.id))] }));
    } catch (reason) { setError(String(reason)); }
    finally { setLoading(false); }
  }
  async function readValues() {
    if (!path || reading) return;
    setReading('values'); setError('');
    try {
      const result = await api<ModuleView>(`${path}/values`);
      setPage(current => ({ ...current, inputs: result.inputs, state: result.state,
        stateTruncated: result.stateTruncated, stateBytes: result.stateBytes, statePreview: result.statePreview }));
    } catch (reason) { setError(String(reason)); }
    finally { setReading(null); }
  }
  async function readTransition(id: string) {
    if (!path || reading) return;
    setReading(id); setError('');
    try {
      const result = await api<ModuleView['transitions'][number]>(`${path}/transitions/${encodeURIComponent(id)}`);
      setPage(current => ({ ...current, transitions: current.transitions.map(item => item.id === id ? result : item) }));
    } catch (reason) { setError(String(reason)); }
    finally { setReading(null); }
  }
  return <>
    <strong>{page.moduleId} · {page.trigger === 'once' ? '一次汇合' : '每次判断'}</strong>
    <p>{page.triggered ? '已触发，等待显式重开' : '等待输入与条件满足'}</p>
    {error && <p role="alert">{error}</p>}{loading && <p>正在读取判断历史…</p>}
    <h4>规则</h4><pre>{JSON.stringify(summary.definition?.rules ?? [], null, 2)}</pre>
    <h4>输入状态</h4><pre data-testid="module-inputs">{JSON.stringify(page.inputs, null, 2)}</pre>
    <h4>持久状态</h4>{page.stateTruncated ? <><p>状态尚未完整加载 · {page.stateBytes} bytes</p><pre>{page.statePreview}</pre></> : <pre>{JSON.stringify(page.state, null, 2)}</pre>}
    {path && (page.stateTruncated || page.inputs.some(input => input.valueTruncated)) && <button type="button" disabled={reading !== null} onClick={() => void readValues()}>读取完整输入与状态</button>}
    <h4>判断记录</h4><ol>{page.transitions.map(transition => <li key={transition.id} data-testid="module-transition">
      <time>{new Date(transition.createdAt).toLocaleString()}</time>
      <pre>{JSON.stringify(transition, null, 2)}</pre>
      {transition.payloadTruncated && path && <><p>判断内容尚未完整加载 · {transition.payloadBytes} bytes</p><button type="button" disabled={reading !== null} onClick={() => void readTransition(transition.id)}>读取完整判断记录</button></>}
    </li>)}</ol>
    {!page.transitions.length && !loading && <p>尚无判断记录</p>}
    {page.nextAfter && path && <button type="button" disabled={loading} onClick={() => void more()}>加载更多判断记录</button>}
    {onReopen && <button type="button" onClick={() => onReopen(page.moduleId)}>重开</button>}
  </>;
}

export function GraphCanvas({ taskId, graph, collapsed, onSelect, selected, onReopen }: {
  taskId?: string | null;
  graph: GraphPayload;
  collapsed: Record<string, boolean>;
  onSelect: (id: string) => void;
  selected?: string | null;
  onReopen?: (id: string) => void;
}) {
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
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
    ...graph.containers.filter(container => !container.parent || !hiddenContainers.has(container.parent)).map(container => {
      const position = graph.layout.positions[container.id] ?? { x: 0, y: 0, width: 240, height: 120 };
      return {
        id: container.id, type: 'graphContainer', position: relativePosition(container.id, position),
        data: { ...container, label: container.id, collapsed: collapsed[container.id] === true }, className: 'container-card',
        measured: { width: position.width, height: position.height },
        style: { width: position.width, height: position.height, zIndex: -1 },
        ...(container.parent ? { parentId: container.parent } : {}),
      };
    }),
    ...graph.nodes.filter(node => !hidden.has(node.id)).map(node => {
      const position = graph.layout.positions[node.id] ?? { x: 0, y: 0, width: 192, height: 48 };
      const tone = nodeTone(node.status);
      return {
        id: node.id, ariaLabel: `${node.label}，${boardStateLabel(node.status)}，按 Enter 打开`, ariaRole: 'button', type: 'graphNode', position: relativePosition(node.id, position),
        data: { id: node.id, label: node.label, nodeType: node.visualKind, tone, status: node.status, boardState: boardNodeState(node.status), unknown: !boardStateKnown(node.status) } satisfies NodeData,
        // Layout already knows the size; providing it keeps event-driven
        // remounts from waiting on a ResizeObserver measurement.
        measured: { width: position.width, height: position.height },
        style: { width: position.width, height: position.height },
        ...(node.container ? { parentId: node.container } : {}),
      };
    }),
  ];
  const representative = (id: string): string => {
    let current = nodeContainer.get(id) ?? containerById.get(id)?.parent;
    let visible = id;
    while (current) {
      if (collapsed[current]) visible = current;
      current = containerById.get(current)?.parent;
    }
    return visible;
  };
  const projectedEdges = graph.layout.edges.map(edge => {
    const source = representative(edge.source), target = representative(edge.target);
    return { ...edge, source, target, folded: source !== edge.source || target !== edge.target };
  }).filter(edge => edge.source !== edge.target || (!edge.folded && Boolean(edge.points?.length)));
  const foldedEdges = projectedEdges.filter(edge => edge.folded);
  const foldedRoutes = useFoldedRoutes(foldedEdges.length ? {
    edges: foldedEdges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target })),
    positions: graph.layout.positions,
    nodeIds: [
      ...graph.nodes.filter(node => !hidden.has(node.id)).map(node => node.id),
      ...graph.containers.filter(group => collapsed[group.id] && (!group.parent || !hiddenContainers.has(group.parent))).map(group => group.id),
    ],
  } : null);
  const publicEndpoint = (owner: string, endpoint: string, direction: 'input' | 'output') => {
    const group = containerById.get(owner);
    if (!group || !collapsed[owner]) return endpoint;
    const ports = direction === 'input' ? group.inputs ?? {} : group.outputs ?? {};
    const mapped = Object.entries(ports).filter(([, port]) => ('to' in port ? port.to : port.from) === endpoint).map(([name]) => name);
    // An explicit connection to an internal port is still shown as internal;
    // no public interface may be inferred merely because its node was hidden.
    return mapped.length ? `${owner}.${mapped.join(' / ')}` : endpoint;
  };
  const edges: Edge[] = projectedEdges.map(edge => {
      const connection = graph.interfaces?.find(item => item.edgeId === edge.id);
      const from = connection ? publicEndpoint(edge.source, connection.from, 'output') : '';
      const to = connection ? publicEndpoint(edge.target, connection.to, 'input') : '';
      const points = edge.folded ? foldedRoutes?.get(edge.id) : edge.points;
      const edgeData = {
        ...(connection ? { edgeLabel: `${from.split('.').slice(1).join('.')} → ${to.split('.').slice(1).join('.')}${connection.enabled ? '' : '（禁用）'}` } : {}),
        ...(points?.length ? { points } : {}),
      };
      return {
        id: edge.id, source: edge.source, target: edge.target, type: 'grid',
        sourceHandle: 'source-bottom',
        targetHandle: 'target-top',
        className: 'grid-edge',
        data: edgeData,
        style: { stroke: '#7c8aa5' }, markerEnd: { type: MarkerType.ArrowClosed, color: '#7c8aa5' },
      };
    });
  const messageGroups = new Map<string, NonNullable<GraphPayload['messages']>>();
  for (const message of graph.messages ?? []) {
    if (!graph.nodes.some(node => node.id === message.source) || !graph.nodes.some(node => node.id === message.target)) continue;
    const source = representative(message.source), target = representative(message.target);
    if (source === target) continue;
    const key = `${source}\u0000${target}`;
    messageGroups.set(key, [...(messageGroups.get(key) ?? []), message]);
  }
  for (const [key, messages] of messageGroups) {
    const [source, target] = key.split('\u0000') as [string, string];
    edges.push({ id: `message:${source}:${target}`, source, target, type: 'message',
      sourceHandle: 'source-right', targetHandle: 'target-left', className: 'graph-message-edge',
      style: { stroke: '#6366f1', strokeDasharray: '5 5' },
      markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1' },
      data: { edgeLabel: `${messages.length} 条消息`, edgeLabelColor: '#6366f1' },
    });
  }
  const selectedModule = graph.modules?.find(item => item.moduleId === selected);
  const selectedInterface = graph.interfaces?.find(item => item.edgeId === selectedEdge);
  const currentEdge = edges.find(edge => edge.id === selectedEdge);
  const currentMessages = currentEdge?.id.startsWith('message:')
    ? messageGroups.get(`${currentEdge.source}\u0000${currentEdge.target}`) ?? [] : [];
  // The four-state legend is rendered here so every view that draws a task
  // graph (task page and conversation drawer) shows the same permanent legend.
  const statuses = graph.nodes.map(node => node.status);
  const legend = boardStateCounts(statuses);
  const unknownCount = boardUnknownCount(statuses);
  return (
    <div className="graph-wrap" data-testid="flow" onKeyDownCapture={event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      if (!(event.target instanceof Element)) return;
      const target = event.target.closest('.react-flow__node, .react-flow__edge');
      if (!target || event.target !== target) return;
      const id = target.getAttribute('data-id');
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      if (target.classList.contains('react-flow__edge')) setSelectedEdge(id);
      else { setSelectedEdge(null); onSelect(id); }
    }}>
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
        onEdgeClick={(_event, edge) => setSelectedEdge(edge.id)}
        onNodeClick={(_event, node) => { setSelectedEdge(null); onSelect(node.id); }} fitView fitViewOptions={{ padding: 0.18 }}
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
      {selectedModule && !selectedEdge && <aside className="graph-edge-inspector" data-testid="graph-module-inspector" aria-label="模块详情">
        <ModuleHistory key={`${taskId}:${selectedModule.moduleId}`} taskId={taskId ?? null} summary={selectedModule} {...(onReopen ? { onReopen } : {})} />
      </aside>}
      {currentEdge && <aside className="graph-edge-inspector" data-testid="graph-edge-inspector">
        <button type="button" aria-label="关闭边详情" onClick={() => setSelectedEdge(null)}>×</button>
        <strong>{currentEdge.source} → {currentEdge.target}</strong>
        {selectedInterface ? <>
          {(currentEdge.source !== selectedInterface.from.split('.')[0] || currentEdge.target !== selectedInterface.to.split('.')[0]) &&
            <p>折叠连接：{publicEndpoint(currentEdge.source, selectedInterface.from, 'output')} → {publicEndpoint(currentEdge.target, selectedInterface.to, 'input')}</p>}
          <p>{selectedInterface.from} → {selectedInterface.to} · {selectedInterface.protocol} · {selectedInterface.enabled ? '启用' : '禁用'}</p>
          <EdgeHistory key={`${taskId}:${selectedInterface.edgeId}`} taskId={taskId ?? null} summary={selectedInterface} />
        </> : currentMessages.length ? <ol>{currentMessages.map(message => <li key={message.id}><small>{message.source} → {message.target}</small><time>{new Date(message.createdAt).toLocaleString()}</time><p>{message.text}</p></li>)}</ol>
          : <p>尚无投递</p>}
      </aside>}
    </div>
  );
}
