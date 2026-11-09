export interface WindowBounds { x: number; y: number; width: number; height: number }
/** Reserve space outside the current content only when the display can hold it.
 * Otherwise the renderer uses an overlay and the existing window stays intact. */
export function drawerWindowBounds(base: WindowBounds, workArea: WindowBounds, panelWidth: number, constrained: boolean) {
  if (constrained || base.width + panelWidth > workArea.width) return { bounds: base, expanded: false };
  return { bounds: { ...base, x: Math.max(workArea.x, Math.min(base.x, workArea.x + workArea.width - base.width - panelWidth)), width: base.width + panelWidth }, expanded: true };
}
