package graph

import (
	"strings"

	"encoding/json"
)

func panicText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(
		strings.TrimPrefix(strings.TrimPrefix(jsonQuote(rec), `"`), `"`), "\n", " "), `"`, ""))
}

func jsonQuote(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}
