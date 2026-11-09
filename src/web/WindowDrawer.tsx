import type { ReactNode } from 'react';

export function WindowDrawer({ open, wide = false, children }: { open: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className="window-drawer-layer" data-open={open} data-wide={wide} aria-hidden={!open}>
      {children}
    </div>
  );
}
