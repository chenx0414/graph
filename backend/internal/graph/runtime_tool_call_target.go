package graph

import (
	"path/filepath"
	"strings"
)

// Which file a tool call targeted, as an absolute path, or empty when a call has no single target.
//
// This is what makes skill usage observable at all: tool_calls records what ran, and the target
// turns "something read something" into "this skill was read, at this time".
//
// Deliberately keyed on well-known argument names rather than per-tool schemas: path is what the
// built-in file tools use (read, write, edit) and the aliases cover tools that name their
// target differently. A tool whose target we cannot identify simply contributes nothing.

const TARGET_LIMIT = 256

var targetKeys = []string{"path", "file_path", "filePath", "target"}

// ToolCallTarget resolves against the instance workspace so derivation is a plain prefix match later on.
// An empty string is the TypeScript null.
func ToolCallTarget(_tool string, args any, workspace string) string {
	record := asMap(args)
	if record == nil {
		return ""
	}
	for _, key := range targetKeys {
		value, ok := record[key].(string)
		if !ok {
			continue
		}
		raw := strings.TrimSpace(value)
		if raw == "" {
			continue
		}
		path := raw
		if !filepath.IsAbs(raw) {
			path = filepath.Join(workspace, raw)
		}
		if len(path) > TARGET_LIMIT {
			return path[:TARGET_LIMIT]
		}
		return path
	}
	return ""
}
