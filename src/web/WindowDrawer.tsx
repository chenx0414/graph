import { useEffect, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** Portal escapes all page stacking/overflow contexts; desktop reserves extra
 * native-window width, web and constrained displays retain an overlay. */
export function WindowDrawer({ open, wide = false, children }: { open: boolean; wide?: boolean; children: ReactNode }) {
  const width = wide ? 760 : 440;
  useEffect(() => {
    let live = true;
    if (open && document.documentElement.dataset.drawerExpanded !== 'true') document.documentElement.style.setProperty('--drawer-base-width', `${window.innerWidth}px`);
    document.documentElement.style.setProperty('--window-drawer-width', `${width}px`);
    void window.graph?.setDrawer?.({ open, width }).then(result => {
      if (live) document.documentElement.dataset.drawerExpanded = String(open && result.expanded);
    }).catch(() => { if(live) document.documentElement.dataset.drawerExpanded = 'false'; });
    return () => { live = false; };
  }, [open,width]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const resized = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if(document.documentElement.dataset.drawerExpanded === 'true') document.documentElement.style.setProperty('--drawer-base-width', `${Math.max(0,window.innerWidth-width)}px`);
      }, 300);
    };
    window.addEventListener('resize',resized);
    return () => { clearTimeout(timer); window.removeEventListener('resize',resized); };
  }, [width]);
  useEffect(() => () => {
    document.documentElement.dataset.drawerExpanded = 'false';
    void window.graph?.setDrawer?.({ open: false, width: 440 }).catch(() => {});
  }, []);
  return createPortal(<div className="window-drawer-layer" data-open={open} data-wide={wide}>{children}</div>, document.body);
}
