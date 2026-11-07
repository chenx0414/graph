package graph

import (
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/pigkernel"

	"os"
)

func toolResultRenderer(scopeId string, stateDir string) pigkernel.ToolResultRenderer {
	if scopeId == "" || stateDir == "" || strings.TrimSpace(os.Getenv("GRAPH_TOOL_RESULT_SEAM")) == "0" {
		return nil
	}
	spillDir := filepath.Join(stateDir, "tool-results")
	hook := ToolResultHook(scopeId, spillDir, nil, os.Getenv("GRAPH_COMPACT_SHELL_RESULTS") == "1")
	return func(name string, args map[string]any, value any) any {
		if name == "bash" {
			if rendered := renderShellOutput(stateDir, value, os.Getenv("GRAPH_COMPACT_SHELL_RESULTS") == "1"); rendered != nil {
				return rendered
			}
		}
		rendered := hook(map[string]any{
			"result":   value,
			"toolCall": map[string]any{"name": name},
			"args":     args,
		})
		if rendered == nil {
			return value
		}
		result := asMap(rendered)
		details := asMap(asMap(value)["details"])
		if len(details) > 0 {
			result["details"] = details
		}
		return result
	}
}
