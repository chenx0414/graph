import { type ReactNode } from 'react';

/** The right drawer is a column of the page, not a layer over it.
 *
 * It takes its width from the content beside it, so the toolbar and its drawer
 * button stay inside the content column and the host window never has to grow
 * to make room. An overlay drawer covered the toolbar, and a window that
 * widened itself left the button looking displaced; both were the same drawer
 * being drawn somewhere it did not belong. */
export function WindowDrawer({ open, wide = false, children }: { open: boolean; wide?: boolean; children: ReactNode }) {
  return (
    <div className="window-drawer-layer" data-open={open} data-wide={wide} aria-hidden={!open}>
      {children}
    </div>
  );
}
