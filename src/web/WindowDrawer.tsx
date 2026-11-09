import { useEffect, useRef, useState, type ReactNode } from 'react';

export function WindowDrawer({ open, wide = false, children }: { open: boolean; wide?: boolean; children: ReactNode }) {
  const width = wide ? 760 : 440;
  const [overlay, setOverlay] = useState(true);
  const [detached, setDetached] = useState(false);
  const expanded = useRef(false);
  const apply = (result: { detached?: boolean; expanded?: boolean } | undefined) => {
    setDetached(result?.detached === true);
    setOverlay(!result?.detached && !result?.expanded);
  };
  const ask = (input: { open: boolean; width: number; route?: string }, update: boolean) => {
    const bridge = window.graph?.setDrawer;
    if (!bridge) {
      setOverlay(true);
      return undefined;
    }
    return bridge(input)
      .then(result => { if (update) apply(result); })
      .catch(() => { if (update) setOverlay(true); });
  };
  useEffect(() => {
    if (open) {
      expanded.current = true;
      void ask({ open: true, width, route: location.hash || '/' }, true);
      return;
    }
    if (expanded.current) {
      expanded.current = false;
      void ask({ open: false, width }, false);
      setDetached(false);
    }
  }, [open, width]);
  useEffect(() => () => {
    if (!expanded.current) return;
    expanded.current = false;
    void ask({ open: false, width }, false);
  }, [width]);
  return (
    <div className="window-drawer-layer" data-open={open} data-wide={wide} data-overlay={overlay} data-detached={detached} aria-hidden={!open}>
      {children}
    </div>
  );
}
