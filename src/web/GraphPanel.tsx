import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.ts';
import { GraphCanvas } from './GraphCanvas.tsx';
import { ErrorBox, useAsync, useTaskStream } from './shared.tsx';
import { Button, Card, Empty, Spinner, toast } from './ui.tsx';

type GraphPayload = React.ComponentProps<typeof GraphCanvas>['graph'] & {
  nodes: React.ComponentProps<typeof GraphCanvas>['graph']['nodes'];
  messages?: { id: string; source: string; target: string; text: string; createdAt: number }[];
  handoffs?: { id: string; source: string; target: string; mode: string; text: string; createdAt: number }[];
  containers: { id: string; parent?: string; nodes: string[] }[];
  loops: { from: string; to: string; reason?: string }[];
  layout: { positions: Record<string, { x: number; y: number; width: number; height: number }>; edges: { id: string; source: string; target: string }[]; branches?: { id: string; source: string; target: string; case: string }[] };
};

export function GraphPanel({ id }: { id: string }) {
  const { data: graph, error, loading, reload } = useAsync(() => api<GraphPayload>(`/api/tasks/${id}/graph`), [id]);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selected, setSelected] = useState<string | null>(null);
  function openNode(nodeId: string) {
    if (graph?.nodes.find(node => node.id === nodeId)?.kind === 'module') { setSelected(nodeId); return; }
    location.hash = `#/tasks/${id}/nodes/${encodeURIComponent(nodeId)}`;
  }
  const { data: view, reload: reloadView } = useAsync(() => api<{ request: string }>(`/api/tasks/${id}`), [id]);
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const refreshAll = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(() => { reload(); reloadView(); }, 150);
  }, [reload, reloadView]);
  useEffect(() => () => clearTimeout(refreshTimer.current), []);
  useTaskStream(id, refreshAll);
  if (loading && !graph) return <Card><Spinner /></Card>;
  if (error && !graph) return <ErrorBox message={error} onRetry={reload} />;
  if (!graph) return <Card><Spinner /></Card>;
  const selectedNode = graph.nodes.find(node => node.id === selected);
  return (
    <div className="stagger task-graph-page" data-testid="graph" data-editable="false">
      {view?.request && <h1 className="task-graph-title" data-testid="task-graph-title">{view.request}</h1>}
      {graph.containers.length > 0 && <Card>
        <div className="row">
          {graph.containers.map(container => (
            <Button key={container.id} size="sm" data-testid={`container-${container.id}`} data-expanded={String(!collapsed[container.id])}
              onClick={() => setCollapsed(current => ({ ...current, [container.id]: !current[container.id] }))}>
              {collapsed[container.id] ? '展开' : '折叠'}子图 {container.id}
            </Button>
          ))}
        </div>
      </Card>}

      <Card title="任务图" icon="graph" subtitle={graph.nodes.length ? `${graph.nodes.length} 个节点` : undefined}
        actions={graph.nodes.length ? <Button size="sm" onClick={() => {
          void api(`/api/tasks/${id}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'relayout' }) }).then(refreshAll).catch(reason => toast(String(reason), 'danger'));
        }}>重新布局</Button> : undefined}>
        {!graph.nodes.length && <Empty icon="graph" title="任务图为空" hint={<span data-testid="graph-empty">尚无 graph 内部节点。</span>} />}
        <GraphCanvas taskId={id} graph={graph} collapsed={collapsed} onSelect={openNode} selected={selected} onReopen={moduleId => {
          void api(`/api/tasks/${id}/graph/control`, { method: 'POST', body: JSON.stringify({ action: 'reopen', moduleId }) }).then(refreshAll).catch(reason => toast(String(reason), 'danger'));
        }} />
      </Card>


    </div>
  );
}
