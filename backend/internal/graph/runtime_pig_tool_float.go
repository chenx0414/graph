package graph

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"sync"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

const (
	toolUsageCall     = "call"
	toolUsageSearch   = "search"
	toolUsageExposure = "exposure"
)

type toolUsageCounts struct {
	Calls     map[string]int `json:"calls"`
	Searches  map[string]int `json:"searches"`
	Exposures map[string]int `json:"exposures"`
}

type toolUsage struct {
	mu     sync.Mutex
	path   string
	counts toolUsageCounts
}

var (
	toolUsageCacheMu sync.Mutex
	toolUsagePaths   = map[string]*toolUsage{}
)

func newToolUsage(path string) *toolUsage {
	usage := &toolUsage{path: path, counts: toolUsageCounts{}}
	if path != "" {
		if payload, error := os.ReadFile(path); error == nil {
			loaded := toolUsageCounts{}
			if json.Unmarshal(payload, &loaded) == nil {
				usage.counts = loaded
			}
		}
	}
	usage.reset()
	return usage
}

func toolUsageAt(path string) *toolUsage {
	if path == "" {
		return nil
	}
	toolUsageCacheMu.Lock()
	defer toolUsageCacheMu.Unlock()
	if usage, ok := toolUsagePaths[path]; ok {
		return usage
	}
	usage := newToolUsage(path)
	toolUsagePaths[path] = usage
	return usage
}

func (usage *toolUsage) reset() {
	if usage.counts.Calls == nil {
		usage.counts.Calls = map[string]int{}
	}
	if usage.counts.Searches == nil {
		usage.counts.Searches = map[string]int{}
	}
	if usage.counts.Exposures == nil {
		usage.counts.Exposures = map[string]int{}
	}
}

func (usage *toolUsage) mark(kind, name string) {
	if usage == nil || name == "" {
		return
	}
	usage.mu.Lock()
	defer usage.mu.Unlock()
	usage.reset()
	switch kind {
	case toolUsageCall:
		usage.counts.Calls[name]++
	case toolUsageSearch:
		usage.counts.Searches[name]++
	case toolUsageExposure:
		usage.counts.Exposures[name]++
	}
}

func (usage *toolUsage) score(name string) int {
	if usage == nil {
		return 0
	}
	usage.mu.Lock()
	defer usage.mu.Unlock()
	return usage.counts.Calls[name] + usage.counts.Searches[name]
}

func (usage *toolUsage) exposures(name string) int {
	if usage == nil {
		return 0
	}
	usage.mu.Lock()
	defer usage.mu.Unlock()
	return usage.counts.Exposures[name]
}

func (usage *toolUsage) flush() error {
	if usage == nil || usage.path == "" {
		return nil
	}
	usage.mu.Lock()
	payload, error := json.Marshal(usage.counts)
	usage.mu.Unlock()
	if error != nil {
		return error
	}
	if error := os.MkdirAll(filepath.Dir(usage.path), 0o755); error != nil {
		return error
	}
	temporary := usage.path + ".tmp"
	if error := os.WriteFile(temporary, payload, 0o644); error != nil {
		return error
	}
	return os.Rename(temporary, usage.path)
}

func toolFloatPinned(options toolDisclosureOptions, name string) bool {
	for _, pinned := range options.Pinned {
		if pinned == name {
			return true
		}
	}
	return false
}

func toolFloatSinkable(names []string, usage *toolUsage, options toolDisclosureOptions) map[string]bool {
	sink := map[string]bool{}
	if !options.FloatEnabled || usage == nil || options.FloatK <= 0 {
		return sink
	}
	ranked := append([]string{}, names...)
	sort.SliceStable(ranked, func(left, right int) bool {
		leftPinned := toolFloatPinned(options, ranked[left])
		if leftPinned != toolFloatPinned(options, ranked[right]) {
			return leftPinned
		}
		leftScore, rightScore := usage.score(ranked[left]), usage.score(ranked[right])
		if leftScore != rightScore {
			return leftScore > rightScore
		}
		return ranked[left] < ranked[right]
	})
	for index, name := range ranked {
		if index < options.FloatK || toolFloatPinned(options, name) {
			continue
		}
		if usage.exposures(name) < options.FloatMinExposures {
			continue
		}
		sink[name] = true
	}
	return sink
}

var toolFloatPinnedDefaults = []string{"bash", "read", "write", "edit", "git"}

func (index *toolDisclosureIndex) markSearched(query, expression string, topK int, usage *toolUsage) ([]map[string]any, error) {
	hits, failure := index.search(query, expression, topK)
	if failure != nil {
		return nil, failure
	}
	if usage == nil {
		return hits, nil
	}
	for _, hit := range hits {
		if name, ok := hit["name"].(string); ok {
			usage.mark(toolUsageSearch, name)
		}
	}
	_ = usage.flush()
	return hits, nil
}

func toolUsageWrapped(spec pigkernel.ToolSpec, usage *toolUsage) pigkernel.ToolSpec {
	if usage == nil {
		return spec
	}
	name := spec.Name
	if execute := spec.Execute; execute != nil {
		spec.Execute = func(ctx context.Context, args map[string]any) (string, error) {
			usage.mark(toolUsageCall, name)
			_ = usage.flush()
			return execute(ctx, args)
		}
	}
	if result := spec.Result; result != nil {
		spec.Result = func(ctx context.Context, args map[string]any) (any, error) {
			usage.mark(toolUsageCall, name)
			_ = usage.flush()
			return result(ctx, args)
		}
	}
	return spec
}
