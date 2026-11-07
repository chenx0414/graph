package graph

import (
	"errors"
	"fmt"
	"strings"
)

func piAdapterAssistantText(message map[string]any) string {
	if message == nil {
		return ""
	}
	role, _ := message["role"].(string)
	if role != "assistant" {
		return ""
	}
	switch content := message["content"].(type) {
	case string:
		return content
	case []any:
		pieces := []string{}
		for _, item := range content {
			part, _ := item.(map[string]any)
			if part["type"] != "text" {
				continue
			}
			text, ok := part["text"].(string)
			if !ok {
				continue
			}
			pieces = append(pieces, text)
		}
		return strings.Join(pieces, "")
	}
	return ""
}

func piAdapterUnique(paths []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range paths {
		if path == "" || seen[path] {
			continue
		}
		seen[path] = true
		out = append(out, path)
	}
	return out
}

func truncateRunes(text string, n int) string {
	runes := []rune(text)
	if len(runes) <= n {
		return text
	}
	return string(runes[:n])
}

func asError(rec any) error {
	if err, ok := rec.(error); ok {
		return err
	}
	return errors.New(fmt.Sprintf("%v", rec))
}

func asFloatValue(value any) float64 {
	number, ok := asFloat(value)
	if !ok {
		return 0
	}
	return number
}

func piAdapterNullableString(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func agentContextRoot(library *AgentContextLibrary) string {
	if library == nil {
		return ""
	}
	return library.ContextRoot
}
