import { useCallback, useEffect, useRef, useState } from 'react';
import { nextEventCursor } from './event-cursor.ts';
import { defaultTargetBranch, type ProjectBranchView } from './project-branch.ts';
import { Button, Icon } from './ui.tsx';

/** One unambiguous rendering for possibly multi-currency costs. */
export function costText(cost: { unknown?: boolean; amounts?: Record<string, number>; amount?: number | null } | null | undefined) {
  if (!cost) return '无记录';
  const amounts = cost.amounts ?? (typeof cost.amount === 'number' ? { '': cost.amount } : {});
  const entries = Object.entries(amounts).filter(([, value]) => value !== 0 || Object.keys(amounts).length === 1);
  const body = entries.map(([currency, value]) => `${Number(value.toFixed(6))}${currency ? ` ${currency}` : ''}`).join(' + ');
  if (cost.unknown && !body) return '费用未知';
  if (cost.unknown) return `${body}（另有未知价格调用）`;
  return body || '无记录';
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div data-testid="error" className="hint-card" style={{ borderColor: 'var(--danger)', color: 'var(--danger)', margin: '8px 0' }}>
      <Icon name="alert" />
      <span><strong>加载失败：</strong>{message}</span>
      {onRetry && <Button size="sm" variant="danger" onClick={onRetry}>重试</Button>}
    </div>
  );
}

/** Target branch for a new task: the project's own branch, not a guessed default. */
export function useTargetBranch(projects: ProjectBranchView[] | null | undefined, projectId: string | null) {
  const [branch, setBranch] = useState('main');
  const touched = useRef(false);
  useEffect(() => {
    if (touched.current) return;
    const known = defaultTargetBranch(projects, projectId);
    if (known) setBranch(known);
  }, [projects, projectId]);
  return { branch, setBranch: (value: string) => { touched.current = true; setBranch(value); } };
}

export function useAsync<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  // Every request gets a generation; a late response from an old key must
  // never overwrite the record the user is looking at now.
  const generation = useRef(0);
  const previousDeps = useRef(deps);
  useEffect(() => {
    // React Activity reconnects effects when a tab becomes visible. Keep its loaded
    // snapshot while revalidating; only a different resource should clear it.
    if (deps.some((value, index) => !Object.is(value, previousDeps.current[index]))) {
      setData(null);
      setError(null);
    }
    previousDeps.current = deps;
    return () => { generation.current += 1; };
  }, deps);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    loadRef.current()
      .then(value => { if (generation.current === current) { setData(value); setError(null); } })
      .catch((reason: unknown) => { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (generation.current === current) setLoading(false); });
  }, deps);
  useEffect(() => {
    // A discarded mount (including StrictMode's effect replay) must not start IO.
    let active = true;
    queueMicrotask(() => { if (active) reload(); });
    return () => { active = false; };
  }, [reload]);
  return { data, error, loading, reload };
}

export type StreamEvent = { cursor: number; type: string; taskId?: string; data?: unknown; timestamp?: number };

/** EventSource with an event cursor. Reconnects from the last applied cursor,
 * so a drop replays only what was missed and duplicate deliveries are ignored.
 * A null URL keeps the stream closed until the record is known. */
export function useEventStream(url: string | null, onEvent: (event: StreamEvent) => void, initialCursor = 0) {
  const [connected, setConnected] = useState(false);
  const cursor = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    cursor.current = initialCursor;
    setConnected(false);
    if (!url) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const open = () => {
      if (closed) return;
      source = new EventSource(`${url}?after=${cursor.current}`);
      source.onopen = () => setConnected(true);
      source.onmessage = message => {
        try {
          const event = nextEventCursor(cursor.current, JSON.parse(message.data));
          if (!event) return;
          cursor.current = event.cursor;
          handler.current(event);
        } catch { /* keep the stream on malformed frames */ }
      };
      source.onerror = () => {
        setConnected(false);
        source?.close();
        source = null;
        if (!closed) timer = setTimeout(open, 1000);
      };
    };
    open();
    return () => { closed = true; clearTimeout(timer); source?.close(); };
  }, [url]);
  return connected;
}

export function useTaskStream(taskId: string | null, onEvent: (event: StreamEvent) => void) {
  return useEventStream(taskId ? `/api/tasks/${taskId}/events/stream` : null, onEvent);
}
