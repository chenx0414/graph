package main

import (
	"testing"
)



func TestTheProvidersPageDropsTheSearchBoxAndTheExplainerLines(t *testing.T) {
	server := magpieProvidersServer(t)
	shell := newShellState(server.URL, "")
	shell.openModule("providers")
	tester := frames(newTester(shell.view, 1440, 900))
	providersFrameUntil(t, tester, func() bool { return len(shell.providers.entries) > 0 })
	for _, gone := range []string{
		"查找供应商",
		"本机供应商写进 graph.config.json · Magpie 是可选的扩展",
		"Magpie 里已连接的供应商会直接出现在模型选择器里，不需要导入。供应商与账号都由 Magpie 管理 · 开关在 Magpie 里。",
	} {
		if tester.HasText(gone) {
			t.Fatalf("the providers page still shows %q", gone)
		}
	}
}

func TestTheRunSettingsPageDropsTheProvidersButtonAndTheSubtitle(t *testing.T) {
	actions := map[string]int{}
	server := settingsServer(t, actions)
	defer server.Close()

	state := newSettingsState(server.URL, "tok")
	state.load()
	tester := newTester(state.view, 820, 620)
	for frame := 0; frame < 3; frame++ {
		render(tester)
	}
	for _, gone := range []string{"管理供应商", "运行状态、源码版本与项目归档"} {
		if tester.HasText(gone) {
			t.Fatalf("the run settings page still shows %q, texts %q", gone, tester.Texts())
		}
	}
	if !tester.HasText("运行设置") {
		t.Fatalf("the page still names itself, texts %q", tester.Texts())
	}
}

func TestTheAgentNetworkCardDropsTheInteractionLegend(t *testing.T) {
	mock := &nodeChatMock{
		fleet: networkPanelFleet(),
		conv: map[string]string{
			"g1": `{"messages":[{"id":"m1","seq":1,"role":"assistant","kind":"message","text":"Main 在这里","createdAt":1}]}`,
		},
	}
	state, tester := nodeChatShell(t, mock)
	state.selectConversation("g1")
	tester = frames(frames(tester))
	for _, gone := range []string{"编队 · Main 中心 · Thread 环 · 拖拽平移 · 滚轮缩放", "拖拽平移 · 滚轮缩放"} {
		if tester.HasText(gone) {
			t.Fatalf("the agent network card still shows %q, texts %q", gone, tester.Texts())
		}
	}
}
