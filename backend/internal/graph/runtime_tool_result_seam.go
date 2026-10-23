package graph

import (
	"os"
	"path/filepath"
	"strings"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

// TOOL_RESULT_SEAM is the switch that turns the tool-result seam off.
//
// The seam is on: a result too large to carry is written to a file the model can
// read by offset and limit. Turning it off returns the result as the tool
// produced it, and the kernel's own truncation cuts it - the switch exists so
// the difference can be measured, and so a host that wants the raw result can
// have it.
//
// Every tool result the session produces passes through it: the text the model
// reads is bounded per tool, and a result too large to carry is written to a
// file the model can read by offset and limit. The file holds every byte, so
// nothing is lost - the model gets a path, a size and a summary instead of a
// result that was cut.
//
// The details of a result are what the console shows rather than what the model
// reads. They survive the rewrite.
func toolResultRenderer(scopeId string, stateDir string) pigkernel.ToolResultRenderer {
	if scopeId == "" || stateDir == "" || strings.TrimSpace(os.Getenv("GRAPH_TOOL_RESULT_SEAM")) == "0" {
		return nil
	}
	spillDir := filepath.Join(stateDir, "tool-results")
	hook := ToolResultHook(scopeId, spillDir, nil, os.Getenv("GRAPH_COMPACT_SHELL_RESULTS") == "1")
	return func(name string, args map[string]any, value any) any {
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
