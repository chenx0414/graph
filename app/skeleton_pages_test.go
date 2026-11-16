package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/kit"
	gwtheme "graph/app/gwui/theme"
)

func skeletonTester(t *testing.T, view func(*ui.Context)) *ui.Tester {
	t.Helper()
	tester := ui.NewTesterWith(func(c *ui.Context) {
		gwtheme.Apply(c, gwtheme.Dark())
		view(c)
	}, 1200, 800, ui.TesterOptions{Preferences: ui.Preferences{ReduceMotion: true}})
	tester.Frame()
	return tester
}

func requireSkeleton(t *testing.T, tester *ui.Tester, where string) {
	t.Helper()
	if _, ok := tester.Find(kit.SkeletonLabel); !ok {
		t.Fatalf("%s must show skeleton placeholders, texts %q", where, tester.Texts())
	}
}

func TestEveryPageHasASkeletonLayout(t *testing.T) {
	pages := map[string]func(*ui.Context){
		"chat":         skeletonChatTranscript,
		"overview":     skeletonOverviewPage,
		"trajectory":   skeletonTrajectoryPage,
		"insights":     skeletonInsightsPage,
		"fleet":        skeletonFleetKPIs,
		"fleet rows":   func(c *ui.Context) { skeletonFleetRows(c, 4) },
		"fleet net":    skeletonFleetNetwork,
		"providers":    skeletonProvidersPage,
		"resources":    skeletonResourcesPage,
		"assemblies":   skeletonAssembliesPage,
		"settings":     skeletonSettingsPage,
		"models":       skeletonModelsPanel,
		"fleet detail": skeletonFleetDetail,
		"graph":        skeletonGraphCanvas,
	}
	for name, page := range pages {
		t.Run(name, func(t *testing.T) {
			requireSkeleton(t, skeletonTester(t, page), name)
		})
	}
}

func TestTheChatShowsSkeletonWhileTheConversationLoads(t *testing.T) {
	chat := &chatState{loading: true, listFirst: -1, listLast: -1}
	tester := skeletonTester(t, func(c *ui.Context) { chat.transcript(c) })
	requireSkeleton(t, tester, "a loading chat")
	if tester.HasText("还没有对话") {
		t.Fatalf("a loading chat is not an empty chat, texts %q", tester.Texts())
	}
}

func TestTheOverviewShowsSkeletonWhileUsageLoads(t *testing.T) {
	shell := &shellState{usage: &usageState{status: "正在汇总用量…"}}
	requireSkeleton(t, skeletonTester(t, shell.panelOverview), "a loading overview")
}

func TestThePanelsShowSkeletonsWhileTheirPagesLoad(t *testing.T) {
	cases := map[string]func(*ui.Context){
		"resources":  func(c *ui.Context) { (&resourceState{status: "正在读取资源库…"}).view(c) },
		"assemblies": func(c *ui.Context) { (&assemblyState{status: "正在读取能力装配…"}).view(c) },
		"settings":   func(c *ui.Context) { (&settingsState{status: "正在读取设置…"}).view(c) },
	}
	for name, view := range cases {
		t.Run(name, func(t *testing.T) { requireSkeleton(t, skeletonTester(t, view), name) })
	}
}

func TestTheFleetPanelsShowSkeletonsWhileTheFleetLoads(t *testing.T) {
	cases := map[string]func(*shellState) func(*ui.Context){
		"kpi": func(s *shellState) func(*ui.Context) { return s.panelFleetKPI },
		"network": func(s *shellState) func(*ui.Context) {
			return func(c *ui.Context) { s.panelChatNetwork(c, "fleet") }
		},
		"collaboration": func(s *shellState) func(*ui.Context) { return s.panelFleetCollaboration },
	}
	for name, panel := range cases {
		t.Run(name, func(t *testing.T) {
			shell := &shellState{fleet: fleetState{loading: true}}
			requireSkeleton(t, skeletonTester(t, panel(shell)), "a loading fleet "+name)
		})
	}
}

func TestTheTrajectoryAndInsightsShowSkeletonsWhileTheyLoad(t *testing.T) {
	trajectory := &shellState{trajectory: trajectoryState{loadState: loadState[conversationTrajectory]{phase: loadBusy}}}
	requireSkeleton(t, skeletonTester(t, trajectory.panelTrajectory), "a loading trajectory")
	insights := &shellState{insights: insightsState{loadState: loadState[trajectoryInsights]{phase: loadBusy}}}
	requireSkeleton(t, skeletonTester(t, insights.panelInsights), "loading insights")
}

func TestTheStartupPanesShowSkeletonsBeforeTheFirstRead(t *testing.T) {
	shell := &shellState{status: "正在读取会话…"}
	shell.dataReady.Store(false)
	requireSkeleton(t, skeletonTester(t, shell.chatPane), "the startup chat pane")
	requireSkeleton(t, skeletonTester(t, shell.conversationPane), "the startup conversation pane")
}
