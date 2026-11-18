package main

import (
	"testing"

	"github.com/egoist/mygo/ui"
)

// nodeSessionContextShell builds a node Agent session with that node's own
// trajectory already loaded, then renders the real shell so the whiteboard's
// "当前上下文" panel is exercised, not just the isolated card component.
func nodeSessionContextShell() (*shellState, *ui.Tester) {
	state := newShellState("http://127.0.0.1:1", "tok")
	chat := newChatState("http://127.0.0.1:1", "tok")
	chat.active = "node:tA/n2"
	chat.source = newNodeChatSource(state.api, "tA", "n2")
	chat.agentTitle = "研究员"
	chat.messages = []transcriptMessage{{ID: "m1", Role: "assistant", Kind: "message", Text: "节点自己的回答", CreatedAt: 1}}
	state.chat = chat
	state.activeID = chat.active
	state.trajectory.data = nodeTrajectory(120_000, 900_000)
	state.trajectory.scopeKey = "node:tA/n2"
	state.modelMeta = map[string]modelMeta{
		"deepseek/deepseek-v4.1-flash": {id: "deepseek/deepseek-v4.1-flash", modelID: "deepseek/deepseek-v4.1-flash", contextWindow: 1_000_000},
	}
	state.board.pages = []boardPage{{
		ID: "board", Title: boardDefaultTitle,
		Panels: []boardPanel{{ID: "context-overview", Kind: "context-overview"}},
		Layout: boardNode{Kind: "panel", PanelID: "context-overview"},
	}}
	tester := frames(ui.NewTester(state.view, 1440, 900))
	return state, tester
}

// TestNodeSessionShowsItsOwnContextCard is the integration acceptance: when a
// node Agent session is open, the whiteboard's context card must show THAT
// node's measured occupancy, window and composition, labelled with the node's
// own name -- never the main session's model or a predicted/peak number. The
// subtitle "研究员 · deepseek-v4.1-flash" is what only the node card produces:
// the main card has no fleet agent for a synthetic node, so it would fall back
// to the bare model name.
func TestNodeSessionShowsItsOwnContextCard(t *testing.T) {
	_, tester := nodeSessionContextShell()
	texts := textsJoined(tester)
	for _, want := range []string{
		"当前上下文", "研究员 · deepseek-v4.1-flash",
		"120.0k", "1.0M tokens", "12.0%", "上下文已用",
		"系统提示词", "≈8.0k", "工具定义", "≈16.0k", "用户消息", "≈1.0k",
		"注入内容", "≈3.0k", "助手消息", "≈80.0k", "工具结果", "≈12.0k",
	} {
		if !tester.HasText(want) {
			t.Fatalf("the node session does not show %q, texts %q", want, texts)
		}
	}
	for _, invented := range []string{"900.0k", "估算", "预留", "预测"} {
		if tester.HasText(invented) {
			t.Fatalf("the node session invents %q, texts %q", invented, texts)
		}
	}
}

// TestNodeSessionContextCardFollowsRealDataOnly checks the integration is
// stable across redraws: a peak-only change must not change what the user sees,
// but a real occupancy change must be reflected after the next frame.
func TestNodeSessionContextCardFollowsRealDataOnly(t *testing.T) {
	state, tester := nodeSessionContextShell()
	before := textsJoined(tester)
	state.trajectory.data.Totals.Context.PeakTokens = 980_000
	tester = frames(tester)
	if got := textsJoined(tester); got != before {
		t.Fatalf("the node session card changed when only the peak changed, before %q after %q", before, got)
	}
	state.trajectory.data.Totals.Context.LastTokens = 200_000
	tester = frames(tester)
	if !tester.HasText("200.0k") || !tester.HasText("20.0%") {
		t.Fatalf("the node session card ignored real occupancy, texts %q", textsJoined(tester))
	}
}

// TestNodeSessionContextCardEmptyState pins the empty state in the real
// whiteboard panel: with no measured occupancy the card says so and invents
// nothing.
func TestNodeSessionContextCardEmptyState(t *testing.T) {
	state, tester := nodeSessionContextShell()
	state.trajectory.data = nodeTrajectory(0, 0)
	tester = frames(tester)
	if !tester.HasText("暂无真实上下文数据") {
		t.Fatalf("the empty node session card shows no empty state, texts %q", textsJoined(tester))
	}
	for _, invented := range []string{"上下文已用", "估算", "预留"} {
		if tester.HasText(invented) {
			t.Fatalf("the empty node session card invents %q, texts %q", invented, textsJoined(tester))
		}
	}
}
