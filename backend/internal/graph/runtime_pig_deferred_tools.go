package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

func pigDeferredToolSurface(request AgentSessionRequest, tools []pigkernel.ToolSpec, provider pigkernel.ProviderBridge) ([]pigkernel.ToolSpec, pigkernel.ProviderBridge, error) {
	hidden := map[string]*atomic.Bool{}
	groups := []struct {
		kind, flag string
		names      []string
	}{
		{"catalog", "GRAPH_DEFER_CATALOG_TOOLS", []string{"get_agent_combination", "get_resource", "list_agent_combinations", "read_system_capabilities", "search_resources", "inspect_graph_system"}},
		{"browser", "GRAPH_DEFER_BROWSER_TOOLS", []string{"agent_browser", "agent_browser_web_search"}},
	}
	for _, group := range groups {
		if os.Getenv(group.flag) != "1" {
			continue
		}
		names := []string{}
		for _, tool := range tools {
			if containsString(group.names, tool.Name) {
				names = append(names, tool.Name)
			}
		}
		if len(names) == 0 {
			continue
		}
		state := filepath.Join(request.StateDir, group.kind+"-tools-loaded.json")
		loaded := &atomic.Bool{}
		data, err := os.ReadFile(state)
		if err == nil {
			var record struct {
				Loaded bool `json:"loaded"`
			}
			if err := json.Unmarshal(data, &record); err != nil {
				return nil, provider, err
			}
			loaded.Store(record.Loaded)
		} else if !os.IsNotExist(err) {
			return nil, provider, err
		}
		for _, name := range names {
			hidden[name] = loaded
		}
		tools = append(tools, pigkernel.ToolSpec{
			Name:        "load_" + group.kind + "_tools",
			Description: "Load bound " + group.kind + " tools: " + strings.Join(names, ", ") + ". Their schemas become available on the next request.",
			Parameters:  map[string]any{"type": "object", "properties": map[string]any{}},
			Execute: func(_ context.Context, _ map[string]any) (string, error) {
				if err := os.MkdirAll(filepath.Dir(state), 0700); err != nil {
					return "", err
				}
				pending := state + "." + graphUUID() + ".tmp"
				defer os.Remove(pending)
				if err := os.WriteFile(pending, []byte(`{"loaded":true}`), 0600); err != nil {
					return "", err
				}
				if err := os.Rename(pending, state); err != nil {
					return "", err
				}
				loaded.Store(true)
				return "Available: " + strings.Join(names, ", "), nil
			},
		})
	}
	if len(hidden) == 0 {
		return tools, provider, nil
	}
	for index, tool := range tools {
		loaded, deferred := hidden[tool.Name]
		if !deferred {
			continue
		}
		original := tool
		tools[index].Result = func(ctx context.Context, args map[string]any) (any, error) {
			if !loaded.Load() {
				return nil, fmt.Errorf("Load the bound tool surface before calling %s", original.Name)
			}
			if original.Result != nil {
				return original.Result(ctx, args)
			}
			text, err := original.Execute(ctx, args)
			return map[string]any{"content": []any{map[string]any{"type": "text", "text": text}}}, err
		}
	}
	stream := provider.Stream
	provider.Stream = func(ctx context.Context, transcript []map[string]any, options map[string]any) (pigkernel.EventStream, error) {
		filtered := make([]map[string]any, 0, len(transcript))
		for _, message := range transcript {
			copy := map[string]any{}
			for key, value := range message {
				copy[key] = value
			}
			if added, ok := message["toolsAdded"].([]any); ok {
				visible := []any{}
				for _, tool := range added {
					loaded, deferred := hidden[controlledToolName(tool)]
					if !deferred || loaded.Load() {
						visible = append(visible, tool)
					}
				}
				copy["toolsAdded"] = visible
			}
			filtered = append(filtered, copy)
		}
		return stream(ctx, filtered, options)
	}
	return tools, provider, nil
}
