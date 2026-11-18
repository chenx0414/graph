package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

// panelNodeContext renders an Agent(node) session's own context card in the
// whiteboard's "当前上下文" panel. A node session must never fall back to the
// main conversation's card: an unmeasured node shows a loading skeleton (and
// keeps asking for its own trajectory), never someone else's occupancy.
func (s *shellState) panelNodeContext(ctx *ui.Context) {
	t := gwtheme.Of(ctx)
	if s.nodeContextCard(ctx) {
		return
	}
	if s.trajectory.failed != "" {
		kit.Text(ctx, s.trajectory.failed, t.Text.Sm).TextColor(t.Muted)
		return
	}
	skeletonCard(ctx, 3, false, true)
}
