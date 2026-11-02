import { useEffect, useState } from 'react';
import { api } from './api.ts';

export type FoldPoint = { x: number; y: number };
export type FoldBox = { x: number; y: number; width: number; height: number };

type FoldRequest = {
  edges: { id: string; source: string; target: string }[];
  positions: Record<string, FoldBox>;
  nodeIds: string[];
};

/** Points for edges whose ends moved onto a folded subgraph container. Absent until the layout module answers. */
export function useFoldedRoutes(request: FoldRequest | null): Map<string, FoldPoint[]> | null {
  const key = request === null ? '' : JSON.stringify(request);
  const [routes, setRoutes] = useState<Map<string, FoldPoint[]> | null>(null);
  useEffect(() => {
    if (!key) {
      setRoutes(null);
      return;
    }
    let cancelled = false;
    void api<{ routes: Record<string, FoldPoint[]> }>('/api/layout/routes', { method: 'POST', body: key })
      .then(body => {
        if (!cancelled) setRoutes(new Map(Object.entries(body.routes ?? {})));
      })
      .catch(() => {
        if (!cancelled) setRoutes(null);
      });
    return () => {
      cancelled = true;
    };
  }, [key]);
  return key ? routes : null;
}
