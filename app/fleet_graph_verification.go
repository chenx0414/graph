package main

import (
	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func fleetGraphVerification(ctx *ui.Context, items []fleetVerification) {
	if len(items) == 0 {
		return
	}
	t, th := gwtheme.Of(ctx), ctx.Theme()
	ui.Scroll(ctx).FillWidth().MaxHeight(th.Space(32)).
		Padding(th.Space(1.5), th.Space(2)).Gap(th.Space(1.5)).
		Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border).Children(func() {
		kit.Text(ctx, "验证证据", t.Text.Sm).FontWeight(650).TextColor(t.Foreground)
		for _, item := range items {
			ui.Column(ctx).FillWidth().Gap(th.Space(0.5)).Children(func() {
				kit.Text(ctx, item.Description, t.Text.Sm).TextColor(t.Foreground).SingleLine().Ellipsis("…")
				ui.Row(ctx).FillWidth().Gap(th.Space(1.5)).Children(func() {
					if item.Baseline != nil {
						fleetVerificationCommit(ctx, "基线失败", item.Baseline, t.Muted)
					}
					if item.Status == "passed" && item.Source != nil {
						fleetVerificationCommit(ctx, "交付通过", item.Source, t.SuccessText)
					}
				})
				if item.Status != "passed" && item.Reason != "" {
					kit.Text(ctx, item.Reason, t.Text.Xs).TextColor(t.Muted)
				}
			})
		}
	})
}

func fleetVerificationCommit(ctx *ui.Context, label string, evidence *fleetVerificationSource, color ui.Color) {
	t := gwtheme.Of(ctx)
	short := evidence.Commit[:min(12, len(evidence.Commit))]
	kit.Text(ctx, label+" "+short, t.Text.Xs).TextColor(color).SingleLine().
		Tooltip(evidence.Commit + " · " + evidence.ID)
}
