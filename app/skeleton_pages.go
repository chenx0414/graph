package main

import (
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func skeletonLoadingStatus(status string) bool {
	return strings.HasPrefix(status, "正在")
}

func skeletonStatCard(c *ui.Context, width, height float32) {
	t, th := gwtheme.Of(c), c.Theme()
	card := ui.Column(c).Width(width).Height(height).Radius(t.Radius.Lg).Background(t.Card).
		Border(gwtheme.Hairline, t.Border).Padding(th.Space(2)).Justify(ui.SpaceBetween)
	card.Children(func() {
		kit.SkeletonLine(c, 54, th.Space(2.5))
		kit.SkeletonLine(c, 38, th.Space(1.5))
	})
}

func skeletonStatRow(c *ui.Context, count int) {
	th := c.Theme()
	ui.Row(c).FillWidth().Wrap().Gap(th.Space(2)).Children(func() {
		for range count {
			skeletonStatCard(c, th.Space(29), th.Space(15))
		}
	})
}

func skeletonCardRow(c *ui.Context, icon, trailing bool) {
	th := c.Theme()
	ui.Row(c).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
		if icon {
			kit.SkeletonBlock(c, th.Space(6.5), th.Space(6.5))
		}
		ui.Column(c).Grow(1).Gap(th.Space(0.75)).Children(func() {
			kit.SkeletonLine(c, 42, th.Space(2))
			kit.SkeletonLine(c, 68, th.Space(1.5))
		})
		if trailing {
			kit.SkeletonLine(c, 12, th.Space(2))
		}
	})
}

func skeletonCard(c *ui.Context, rows int, icon, trailing bool) {
	t, th := gwtheme.Of(c), c.Theme()
	card := ui.Column(c).FillWidth().Radius(t.Radius.Md).Border(gwtheme.Hairline, t.Border).
		Background(t.Card).Padding(th.Space(1.5)).Gap(th.Space(1.5))
	card.Children(func() {
		for range rows {
			skeletonCardRow(c, icon, trailing)
		}
	})
}

func skeletonChatTranscript(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).Grow(1).FillWidth().Padding(th.Space(4), th.Space(5)).Gap(th.Space(3)).Children(func() {
		for index := range 5 {
			user := index%2 == 1
			row := ui.Row(c).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Start)
			if user {
				row.Justify(ui.End)
			}
			row.Children(func() {
				if !user {
					kit.SkeletonCircle(c, th.Space(6))
				}
				bubbleWidth := float32(46)
				if user {
					bubbleWidth = 38
				}
				bubble := ui.Column(c).WidthPercent(bubbleWidth).Radius(t.Radius.Xl).Padding(th.Space(2), th.Space(2.5)).
					Gap(th.Space(1)).Background(t.Card)
				bubble.Children(func() {
					kit.SkeletonLine(c, 94, th.Space(2))
					kit.SkeletonLine(c, 72, th.Space(2))
					if index%3 == 0 {
						kit.SkeletonLine(c, 45, th.Space(2))
					}
				})
			})
		}
	})
}

func skeletonOverviewPage(c *ui.Context) {
	th := c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2)).Children(func() {
		skeletonStatRow(c, 6)
		kit.SkeletonLine(c, 42, th.Space(2))
	})
}

func skeletonTrajectoryPage(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2)).Children(func() {
		ui.Row(c).FillWidth().Gap(th.Space(1)).AlignItems(ui.Center).Children(func() {
			kit.SkeletonLine(c, 20, th.Space(2))
			ui.Spacer(c)
			kit.SkeletonLine(c, 10, th.Space(1.5))
		})
		for range 2 {
			ui.Row(c).FillWidth().Gap(th.Space(1)).Children(func() {
				for range 3 {
					cell := ui.Column(c).Grow(1).Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.75)).
						Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
					cell.Children(func() {
						kit.SkeletonLine(c, 48, th.Space(2))
						kit.SkeletonLine(c, 66, th.Space(1.5))
					})
				}
			})
		}
		for range 3 {
			card := ui.Column(c).FillWidth().Gap(th.Space(1.25)).Padding(th.Space(2)).
				Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
			card.Children(func() {
				kit.SkeletonLine(c, 32, th.Space(2))
				kit.SkeletonLine(c, 88, th.Space(1.75))
				kit.SkeletonLine(c, 61, th.Space(1.75))
			})
		}
	})
}

func skeletonFleetKPIs(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(1)).Children(func() {
		ui.Row(c).FillWidth().Gap(th.Space(1.5)).Children(func() {
			for range 6 {
				cell := ui.Column(c).Grow(1).Padding(th.Space(1), th.Space(1.5)).Gap(th.Space(0.5)).
					Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border)
				cell.Children(func() {
					kit.SkeletonLine(c, 58, th.Space(2))
					kit.SkeletonLine(c, 40, th.Space(1.5))
				})
			}
		})
		kit.SkeletonLine(c, 36, th.Space(1.75))
	})
}

func skeletonFleetRows(c *ui.Context, rows int) {
	th := c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(1.25)).Children(func() {
		ui.Row(c).FillWidth().Gap(th.Space(1)).Children(func() {
			for range 3 {
				kit.SkeletonLine(c, 16, th.Space(2))
			}
		})
		skeletonCard(c, rows, false, true)
	})
}

func skeletonFleetNetwork(c *ui.Context) {
	th := c.Theme()
	ui.Column(c).FillWidth().Grow(1).Gap(th.Space(2)).Justify(ui.Center).AlignItems(ui.Center).Children(func() {
		ui.Row(c).Gap(th.Space(6)).AlignItems(ui.Center).Children(func() {
			kit.SkeletonCircle(c, th.Space(9))
			kit.SkeletonCircle(c, th.Space(6))
			kit.SkeletonCircle(c, th.Space(6))
		})
		kit.SkeletonLine(c, 44, th.Space(2))
		kit.SkeletonLine(c, 28, th.Space(1.5))
	})
}

func skeletonProvidersPage(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2)).Children(func() {
		ui.Row(c).FillWidth().Gap(th.Space(1)).Children(func() {
			for range 3 {
				kit.SkeletonLine(c, 10, th.Space(1.75))
			}
			ui.Spacer(c)
			kit.SkeletonLine(c, 18, th.Space(2.5))
		})
		card := ui.Column(c).FillWidth().Radius(t.Radius.Lg).Border(gwtheme.Hairline, t.Border).Background(t.Card).
			Padding(th.Space(2)).Gap(th.Space(1.75))
		card.Children(func() {
			for range 7 {
				skeletonCardRow(c, true, true)
			}
		})
	})
}

func skeletonResourcesPage(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2)).Children(func() {
		ui.Row(c).FillWidth().Gap(th.Space(1)).Children(func() {
			kit.SkeletonLine(c, 26, th.Space(3))
			ui.Spacer(c)
			kit.SkeletonLine(c, 18, th.Space(3))
		})
		kit.SkeletonLine(c, 100, th.Space(7))
		ui.Row(c).FillWidth().Gap(th.Space(1)).Children(func() {
			for range 4 {
				kit.SkeletonLine(c, 10, th.Space(2))
			}
		})
		kit.SkeletonLine(c, 18, th.Space(1.75))
		skeletonCard(c, 5, true, true)
		ui.Row(c).FillWidth().Wrap().Gap(th.Space(2)).Children(func() {
			for range 3 {
				card := ui.Column(c).Width(th.Space(44)).Height(th.Space(28)).Radius(t.Radius.Lg).
					Background(t.Card).Border(gwtheme.Hairline, t.Border).Padding(th.Space(2)).Gap(th.Space(1))
				card.Children(func() {
					kit.SkeletonLine(c, 28, th.Space(5))
					kit.SkeletonLine(c, 54, th.Space(2))
					kit.SkeletonLine(c, 82, th.Space(1.5))
				})
			}
		})
	})
}

func skeletonAssembliesPage(c *ui.Context) {
	th := c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2)).Children(func() {
		ui.Row(c).FillWidth().Gap(th.Space(1)).Children(func() {
			kit.SkeletonLine(c, 34, th.Space(2))
			ui.Spacer(c)
			kit.SkeletonLine(c, 16, th.Space(2.5))
		})
		kit.SkeletonLine(c, 88, th.Space(1.75))
		kit.SkeletonLine(c, 46, th.Space(1.5))
		skeletonCard(c, 5, false, true)
	})
}

func skeletonSettingsPage(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2.5)).Children(func() {
		for range 3 {
			ui.Column(c).FillWidth().Gap(th.Space(1)).Children(func() {
				kit.SkeletonLine(c, 14, th.Space(1.75))
				card := ui.Column(c).FillWidth().Radius(t.Radius.Lg).Background(t.Card).Border(gwtheme.Hairline, t.Border).
					Padding(th.Space(2)).Gap(th.Space(2))
				card.Children(func() {
					for range 3 {
						ui.Row(c).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
							ui.Column(c).Grow(1).Gap(th.Space(0.5)).Children(func() {
								kit.SkeletonLine(c, 26, th.Space(2))
								kit.SkeletonLine(c, 52, th.Space(1.5))
							})
							kit.SkeletonLine(c, 14, th.Space(2))
						})
					}
				})
			})
		}
	})
}

func skeletonModelsPanel(c *ui.Context) {
	th := c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(1.5)).Children(func() {
		kit.SkeletonLine(c, 26, th.Space(1.75))
		for range 4 {
			ui.Row(c).FillWidth().Gap(th.Space(1.5)).Children(func() {
				kit.SkeletonLine(c, 64, th.Space(2))
				kit.SkeletonLine(c, 12, th.Space(2))
			})
		}
	})
}

func skeletonFleetDetail(c *ui.Context) {
	th := c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(2)).Children(func() {
		kit.SkeletonLine(c, 34, th.Space(3))
		kit.SkeletonLine(c, 58, th.Space(1.75))
		skeletonCard(c, 5, false, true)
	})
}

func skeletonGraphCanvas(c *ui.Context) {
	t, th := gwtheme.Of(c), c.Theme()
	ui.Column(c).FillWidth().Grow(1).Gap(th.Space(2)).Children(func() {
		ui.Row(c).FillWidth().AlignItems(ui.Center).Gap(th.Space(1)).Children(func() {
			kit.SkeletonLine(c, 22, th.Space(2.5))
			ui.Spacer(c)
			kit.SkeletonLine(c, 12, th.Space(2))
		})
		canvas := ui.Column(c).FillWidth().Grow(1).Radius(t.Radius.Lg).Background(t.Card).
			Border(gwtheme.Hairline, t.Border).Center().Gap(th.Space(2))
		canvas.Children(func() {
			ui.Row(c).Gap(th.Space(5)).AlignItems(ui.Center).Children(func() {
				kit.SkeletonCircle(c, th.Space(10))
				kit.SkeletonCircle(c, th.Space(7))
				kit.SkeletonCircle(c, th.Space(7))
			})
			kit.SkeletonLine(c, 12, th.Space(1.75))
		})
	})
}

func (s *shellState) fleetUnavailable(ctx *ui.Context) bool {
	if s.fleet.data != nil {
		return false
	}
	if s.fleet.failed != "" {
		s.boardNote(ctx, s.fleet.failed)
		return true
	}
	s.ensureFleet()
	return false
}

func skeletonSidebarRows(c *ui.Context, rows int) {
	th := c.Theme()
	ui.Column(c).FillWidth().Gap(th.Space(1.5)).Padding(0, th.Space(1)).Children(func() {
		for range rows {
			ui.Row(c).FillWidth().Gap(th.Space(1.5)).AlignItems(ui.Center).Children(func() {
				kit.SkeletonBlock(c, th.Space(4.5), th.Space(4.5))
				kit.SkeletonLine(c, 62, th.Space(2))
			})
		}
	})
}
