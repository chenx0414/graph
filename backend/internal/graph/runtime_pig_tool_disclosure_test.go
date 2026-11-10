package graph

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

type toolSearchStream struct{ events []map[string]any }

func (stream *toolSearchStream) Next() (map[string]any, bool) {
	if len(stream.events) == 0 {
		return nil, false
	}
	event := stream.events[0]
	stream.events = stream.events[1:]
	return event, true
}

func (stream *toolSearchStream) Result() map[string]any { return map[string]any{} }

func toolSearchFixture() []pigkernel.ToolSpec {
	return []pigkernel.ToolSpec{
		{Name: "bash", Description: "运行 shell 命令", Parameters: map[string]any{"type": "object"}},
		{Name: "artifact_publish", Description: "Publish a versioned artifact for later tasks", Parameters: map[string]any{"type": "object", "properties": map[string]any{"name": map[string]any{"type": "string"}}}},
		{Name: "git_history", Description: "读取 git 提交历史与 blame，按提交查看改动", Parameters: map[string]any{"type": "object", "properties": map[string]any{"path": map[string]any{"type": "string", "description": "仓库路径"}}}},
		{Name: "agent_browser", Description: "Control a real browser page", Parameters: map[string]any{"type": "object"}},
	}
}

func toolSearchOptions() toolDisclosureOptions {
	return toolDisclosureOptions{Enabled: true, MinTools: 2, TopKDefault: 5, TopKMax: 20, MaxSchema: 4000, Core: []string{"bash"}}
}

func toolSearchFind(t *testing.T, tools []pigkernel.ToolSpec, name string) pigkernel.ToolSpec {
	t.Helper()
	for _, tool := range tools {
		if tool.Name == name {
			return tool
		}
	}
	t.Fatalf("tool %q missing from the surfaced list", name)
	return pigkernel.ToolSpec{}
}

func TestToolSearchFindsIntegrationToolByChineseIntent(t *testing.T) {
	index := newToolDisclosureIndex(toolSearchFixture(), 4000)
	hits := index.search("读取 git 提交历史", "", 5)
	if len(hits) == 0 {
		t.Fatal("expected a hit for a Chinese intent")
	}
	if hits[0]["name"] != "git_history" {
		t.Fatalf("expected git_history first, got %v", hits[0]["name"])
	}
	if hits[0]["input_schema"] == nil {
		t.Fatal("a hit must carry the parameter schema")
	}
}

func TestToolSearchFiltersByRegex(t *testing.T) {
	index := newToolDisclosureIndex(toolSearchFixture(), 4000)
	hits := index.search("", "browser", 5)
	if len(hits) != 1 || hits[0]["name"] != "agent_browser" {
		t.Fatalf("expected only agent_browser, got %v", hits)
	}
}

func TestToolSearchClampsTopKAndRejectsEmptyQuery(t *testing.T) {
	options := toolSearchOptions()
	options.TopKDefault = 2
	deferred, index := toolDisclosurePlanOf(toolSearchFixture(), options)
	if deferred == nil {
		t.Fatal("expected deferred tools above the threshold")
	}
	search := toolSearchSpec(deferred, index, options)
	text, error := search.Execute(context.Background(), map[string]any{"query": "publish artifact", "top_k": float64(100)})
	if error != nil {
		t.Fatalf("search failed: %v", error)
	}
	payload := struct {
		Hits  []map[string]any `json:"hits"`
		Total int              `json:"total"`
	}{}
	if error := json.Unmarshal([]byte(text), &payload); error != nil {
		t.Fatalf("search result is not JSON: %v", error)
	}
	if len(payload.Hits) > options.TopKMax {
		t.Fatalf("top_k not clamped: %d hits", len(payload.Hits))
	}
	if payload.Total != len(deferred) {
		t.Fatalf("expected total %d, got %d", len(deferred), payload.Total)
	}
	if _, error := search.Execute(context.Background(), map[string]any{}); error == nil {
		t.Fatal("an empty query must be rejected")
	}
}

func TestDisclosureKeepsCoreInlineAndDefersTheLongTail(t *testing.T) {
	tools := toolSearchFixture()
	guarded, _, error := pigToolSearchSurface(tools, pigkernel.ProviderBridge{}, toolSearchOptions())
	if error != nil {
		t.Fatalf("surface failed: %v", error)
	}
	names := map[string]bool{}
	for _, tool := range guarded {
		names[tool.Name] = true
	}
	if !names["tool_search"] || !names["tool_invoke"] {
		t.Fatalf("the gateways must always be present, got %v", names)
	}
}

func TestDisclosureStaysInlineBelowTheThreshold(t *testing.T) {
	options := toolSearchOptions()
	options.MinTools = 100
	guarded, _, error := pigToolSearchSurface(toolSearchFixture(), pigkernel.ProviderBridge{}, options)
	if error != nil {
		t.Fatalf("surface failed: %v", error)
	}
	for _, tool := range guarded {
		if tool.Name == "tool_search" || tool.Name == "tool_invoke" {
			t.Fatalf("a small inventory must not advertise %s", tool.Name)
		}
	}
	if len(guarded) != len(toolSearchFixture()) {
		t.Fatalf("expected the full inventory, got %d tools", len(guarded))
	}
}

func TestDeferredToolSchemasLeaveTheRequest(t *testing.T) {
	captured := []map[string]any{}
	provider := pigkernel.ProviderBridge{Stream: func(_ context.Context, transcript []map[string]any, _ map[string]any) (pigkernel.EventStream, error) {
		captured = append(captured, transcript...)
		return &toolSearchStream{}, nil
	}}
	_, guardedProvider, error := pigToolSearchSurface(toolSearchFixture(), provider, toolSearchOptions())
	if error != nil {
		t.Fatalf("surface failed: %v", error)
	}
	declaration := func(name string) map[string]any { return map[string]any{"name": name, "description": name} }
	transcript := []map[string]any{{
		"role":       "system",
		"toolsAdded": []any{declaration("bash"), declaration("git_history"), declaration("tool_search")},
	}}
	if _, error := guardedProvider.Stream(context.Background(), transcript, nil); error != nil {
		t.Fatalf("stream failed: %v", error)
	}
	if len(captured) != 1 {
		t.Fatalf("expected one message, got %d", len(captured))
	}
	names := []string{}
	for _, tool := range captured[0]["toolsAdded"].([]any) {
		names = append(names, controlledToolName(tool))
	}
	if strings.Join(names, ",") != "bash,tool_search" {
		t.Fatalf("deferred schemas must not reach the model, got %v", names)
	}
	if len(transcript[0]["toolsAdded"].([]any)) != 3 {
		t.Fatal("the caller's transcript must not be mutated")
	}
}

func TestDirectCallToDeferredToolPointsAtSearch(t *testing.T) {
	guarded, _, error := pigToolSearchSurface(toolSearchFixture(), pigkernel.ProviderBridge{}, toolSearchOptions())
	if error != nil {
		t.Fatalf("surface failed: %v", error)
	}
	hidden := toolSearchFind(t, guarded, "git_history")
	if hidden.Result == nil {
		t.Fatal("a deferred tool must carry the guard")
	}
	_, failure := hidden.Result(context.Background(), map[string]any{})
	if failure == nil || !strings.Contains(failure.Error(), "tool_search") {
		t.Fatalf("expected guidance toward tool_search, got %v", failure)
	}
}

func TestToolInvokeRunsDeferredTool(t *testing.T) {
	tools := toolSearchFixture()
	tools[2].Execute = func(_ context.Context, args map[string]any) (string, error) {
		return "history of " + args["path"].(string), nil
	}
	guarded, _, error := pigToolSearchSurface(tools, pigkernel.ProviderBridge{}, toolSearchOptions())
	if error != nil {
		t.Fatalf("surface failed: %v", error)
	}
	invoke := toolSearchFind(t, guarded, "tool_invoke")
	text, error := invoke.Execute(context.Background(), map[string]any{"name": "git_history", "arguments": map[string]any{"path": "backend"}})
	if error != nil {
		t.Fatalf("invoke failed: %v", error)
	}
	if text != "history of backend" {
		t.Fatalf("unexpected result %q", text)
	}
	if _, error := invoke.Execute(context.Background(), map[string]any{"name": "unknown"}); error == nil {
		t.Fatal("an unknown tool must be refused")
	}
}
