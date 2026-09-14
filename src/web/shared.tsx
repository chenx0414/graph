import { useCallback, useEffect, useRef, useState } from 'react';
import { nextEventCursor } from './event-cursor.ts';

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div data-testid="error" style={{ background: '#fde8e8', border: '1px solid #e0a0a0', padding: '8px 12px', margin: '8px 0' }}>
      <strong>加载失败：</strong>{message}
      {onRetry && <button type="button" style={{ marginLeft: 8 }} onClick={onRetry}>重试</button>}
    </div>
  );
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
  useEffect(() => {
    generation.current += 1;
    setData(null);
    setError(null);
  }, deps);
  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    loadRef.current()
      .then(value => { if (generation.current === current) { setData(value); setError(null); } })
      .catch((reason: unknown) => { if (generation.current === current) setError(reason instanceof Error ? reason.message : String(reason)); })
      .finally(() => { if (generation.current === current) setLoading(false); });
  }, deps);
  useEffect(() => { reload(); }, [reload]);
  return { data, error, loading, reload };
}

/** EventSource with an event cursor. Reconnects from the last applied cursor,
 * so a drop replays only what was missed and duplicate deliveries are ignored.
 * A null task id keeps the stream closed until the record is known. */
export function useTaskStream(taskId: string | null, onEvent: (event: { cursor: number; type: string; data?: unknown; timestamp?: number }) => void) {
  const [connected, setConnected] = useState(false);
  const cursor = useRef(0);
  const handler = useRef(onEvent);
  handler.current = onEvent;
  useEffect(() => {
    cursor.current = 0;
    setConnected(false);
    if (!taskId) return;
    let source: EventSource | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let closed = false;
    const open = () => {
      if (closed) return;
      source = new EventSource(`/api/tasks/${taskId}/events/stream?after=${cursor.current}`);
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
  }, [taskId]);
  return connected;
}
