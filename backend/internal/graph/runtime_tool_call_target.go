package graph

import (
	"strings"

	"path/filepath"
)

const TARGET_LIMIT = 256

var targetKeys = []string{"path", "file_path", "filePath", "target"}

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
