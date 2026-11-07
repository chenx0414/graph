package graph

import (
	"strings"

	"encoding/json"
)

// panicText is the message a recovered value carries.
//
// A panic in this codebase is either an error or a value somebody serialised
// for a reader; both have to reach the log as one line.
func panicText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(
		strings.TrimPrefix(strings.TrimPrefix(jsonQuote(rec), `"`), `"`), "\n", " "), `"`, ""))
}

// jsonQuote encodes one value as JSON, or the empty string when it cannot be.
func jsonQuote(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}
