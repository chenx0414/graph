import { useEffect, useRef, useState, type ReactNode } from 'react';

export function WindowDrawer({ open, wide = false, children }: { open: boolean; wide?: boolean; children: ReactNode }) {
  const width = wide ? 760 : 440;
  const [overlay, setOverlay] = useState(true);
  const expanded = useRef(false);
  const ask = (input: { open: boolean; width: number }, update: boolean) => {
    const bridge = window.graph?.setDrawer;
    if (!bridge) {
      setOverlay(true);
      return undefined;
    }
    return bridge(input)
      .then(result => { if (update) setOverlay(!result?.expanded); })
      .catch(() => { if (update) setOverlay(true); });
  };
  useEffect(() => {
    if (open) {
      expanded.current = true;
      void ask({ open: true, width }, true);
      return;
    }
    if (expanded.current) {
      expanded.current = false;
      void ask({ open: false, width }, false);
    }
  }, [open, width]);
  useEffect(() => () => {
    if (!expanded.current) return;
    expanded.current = false;
    void ask({ open: false, width }, false);
  }, [width]);
  return (
    <div className="window-drawer-layer" data-open={open} data-wide={wide} data-overlay={overlay} aria-hidden={!open}>
      {children}
    </div>
  );
}
