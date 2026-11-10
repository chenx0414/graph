package graph

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func toolFloatOptions(pinned []string, k, floor int) toolDisclosureOptions {
	return toolDisclosureOptions{
		Enabled:           true,
		FloatEnabled:      true,
		FloatK:            k,
		FloatMinExposures: floor,
		Pinned:            pinned,
	}
}

func TestToolFloatKeepsTheMostUsedToolsInsideTheWindow(t *testing.T) {
	usage := newToolUsage("")
	names := []string{"bash", "read", "write", "edit"}
	for _, name := range names {
		for index := 0; index < 5; index++ {
			usage.mark(toolUsageExposure, name)
		}
	}
	for index := 0; index < 3; index++ {
		usage.mark(toolUsageCall, "read")
	}

	sink := toolFloatSinkable(names, usage, toolFloatOptions([]string{"bash"}, 2, 1))
	if sink["bash"] {
		t.Fatalf("a pinned tool sank: %v", sink)
	}
	if sink["read"] {
		t.Fatalf("the most used tool sank: %v", sink)
	}
	if !sink["edit"] || !sink["write"] {
		t.Fatalf("the unused tools stayed inline: %v", sink)
	}
}

func TestToolFloatSinksNothingBeforeTheToolWasExposedEnough(t *testing.T) {
	usage := newToolUsage("")
	names := []string{"read", "write", "edit"}
	for _, name := range names {
		usage.mark(toolUsageExposure, name)
	}

	if sink := toolFloatSinkable(names, usage, toolFloatOptions(nil, 1, 3)); len(sink) != 0 {
		t.Fatalf("a tool sank before the exposure floor: %v", sink)
	}
	if sink := toolFloatSinkable(names, usage, toolFloatOptions(nil, 1, 1)); len(sink) != 2 {
		t.Fatalf("the window kept %d tools instead of 1: %v", len(names)-len(sink), sink)
	}
}

func TestToolFloatReordersAsTheUsageChanges(t *testing.T) {
	usage := newToolUsage("")
	names := []string{"read", "write", "edit"}
	for _, name := range names {
		usage.mark(toolUsageExposure, name)
	}
	usage.mark(toolUsageCall, "read")
	options := toolFloatOptions(nil, 1, 1)
	if sink := toolFloatSinkable(names, usage, options); sink["read"] || !sink["write"] {
		t.Fatalf("the window did not follow the usage: %v", sink)
	}

	usage.mark(toolUsageCall, "write")
	usage.mark(toolUsageCall, "write")
	if sink := toolFloatSinkable(names, usage, options); !sink["read"] || sink["write"] {
		t.Fatalf("the window did not move to the newly used tool: %v", sink)
	}
}

func TestToolFloatUsageSurvivesTheProcess(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tool-usage.json")
	usage := newToolUsage(path)
	for index := 0; index < 4; index++ {
		usage.mark(toolUsageCall, "read")
	}
	usage.mark(toolUsageSearch, "read")
	usage.mark(toolUsageExposure, "read")
	if error := usage.flush(); error != nil {
		t.Fatalf("flush: %v", error)
	}

	reloaded := newToolUsage(path)
	if score := reloaded.score("read"); score != 5 {
		t.Fatalf("the reloaded score is %d, want 5", score)
	}
	if exposures := reloaded.exposures("read"); exposures != 1 {
		t.Fatalf("the reloaded exposure count is %d, want 1", exposures)
	}
	if _, error := os.Stat(path); error != nil {
		t.Fatalf("the usage file is missing: %v", error)
	}
}

func TestToolFloatSurfaceHidesTheToolsBelowTheWindow(t *testing.T) {
	usage := newToolUsage("")
	options := toolSearchOptions()
	options.OnDemand = nil
	options.Usage = usage
	options.FloatEnabled = true
	options.FloatK = 1
	options.FloatMinExposures = 1
	for _, name := range []string{"bash", "artifact_publish", "git_history", "agent_browser"} {
		usage.mark(toolUsageExposure, name)
	}
	usage.mark(toolUsageCall, "bash")

	guarded, _, error := pigToolSearchSurface(toolSearchFixture(), pigkernel.ProviderBridge{}, options)
	if error != nil {
		t.Fatalf("surface: %v", error)
	}
	hidden := toolSearchFind(t, guarded, "artifact_publish")
	_, failure := hidden.Result(context.Background(), map[string]any{})
	if failure == nil || !strings.Contains(failure.Error(), "on-demand") {
		t.Fatalf("a tool below the window stayed direct: %v", failure)
	}
	if kept := toolSearchFind(t, guarded, "bash"); kept.Result != nil {
		t.Fatal("the most used tool must keep its real implementation")
	}
}

func TestToolFloatRecordsSearchHitsAndInvokesAsUsage(t *testing.T) {
	usage := newToolUsage("")
	options := toolSearchOptions()
	options.OnDemand = []string{"git_history"}
	options.Usage = usage
	tools := toolSearchFixture()
	tools[2].Execute = func(_ context.Context, _ map[string]any) (string, error) { return "history", nil }
	guarded, _, error := pigToolSearchSurface(tools, pigkernel.ProviderBridge{}, options)
	if error != nil {
		t.Fatalf("surface: %v", error)
	}
	search := toolSearchFind(t, guarded, "tool_search")
	if _, error := search.Execute(context.Background(), map[string]any{"query": "git 提交历史"}); error != nil {
		t.Fatalf("search: %v", error)
	}
	if usage.score("git_history") == 0 {
		t.Fatal("a search hit did not count as usage")
	}
	before := usage.score("git_history")
	invoke := toolSearchFind(t, guarded, "tool_invoke")
	if _, error := invoke.Execute(context.Background(), map[string]any{"name": "git_history", "arguments": map[string]any{"path": "backend"}}); error != nil {
		t.Fatalf("invoke: %v", error)
	}
	if usage.score("git_history") <= before {
		t.Fatal("an on-demand run did not count as usage")
	}
}
