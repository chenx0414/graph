package main

import (
	"strings"
	"testing"

	"graph/verification/internal/appinstance"
)

func TestFindAccessMatchesRoleAndAcceptsTextFieldAsText(t *testing.T) {
	snapshot := appinstance.Snapshot{Nodes: []appinstance.Node{
		{Name: "消息", Role: "textfield", Value: "typed"},
		{Name: "洞察", Role: "button"},
		{Name: "消息", Role: "statictext", Value: "label"},
	}}
	if node, ok := findAccess(snapshot, "消息", ""); !ok || node.Value != "typed" {
		t.Fatalf("an empty role must match the first named node, got %+v ok=%v", node, ok)
	}
	if node, ok := findAccess(snapshot, "消息", "text"); !ok || node.Role != "textfield" {
		t.Fatalf("role text must accept textfield, got %+v ok=%v", node, ok)
	}
	if _, ok := findAccess(snapshot, "消息", "button"); ok {
		t.Fatal("a role mismatch must not fall back to a different role")
	}
	if _, ok := findAccess(snapshot, "缺失", ""); ok {
		t.Fatal("a missing name must not match")
	}
}

func TestNamesSummaryKeepsBothEndsOfALongTree(t *testing.T) {
	nodes := []appinstance.Node{}
	for index := 0; index < 60; index++ {
		nodes = append(nodes, appinstance.Node{Name: "node-" + string(rune('a'+index%26))})
	}
	nodes[0].Name = "first"
	nodes[len(nodes)-1].Name = "last"
	summary := namesSummary(appinstance.Snapshot{Nodes: nodes})
	if !strings.Contains(summary, "first") || !strings.Contains(summary, "last") {
		t.Fatalf("a long summary must show both ends: %s", summary)
	}
	if !strings.Contains(summary, "more") {
		t.Fatalf("a long summary must say it was truncated: %s", summary)
	}
	if len(summary) > 4000 {
		t.Fatalf("the summary grew without bound: %d chars", len(summary))
	}
}

func TestMergeAccessKeepsAssertedValuesAndTheWholeFrame(t *testing.T) {
	asserted := []accessDump{{Name: "消息", Role: "textfield", Value: "typed"}}
	full := []accessDump{
		{Name: "消息", Role: "textfield", Value: "typed"},
		{Name: "洞察", Role: "button"},
		{Name: "标签页 白板", Role: "button"},
	}
	merged := mergeAccess(asserted, full)
	if len(merged) != 3 {
		t.Fatalf("merged = %+v; the final frame must keep every named control", merged)
	}
	if merged[0].Name != "消息" || merged[0].Value != "typed" {
		t.Fatalf("the asserted node must come first with its value, got %+v", merged[0])
	}
	if len(mergeAccess(nil, full)) != 3 {
		t.Fatal("a journey without assertAccess must still record the full frame")
	}
}
