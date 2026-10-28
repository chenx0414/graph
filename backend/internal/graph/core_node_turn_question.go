package graph

import "strings"

// nodeTurnOutputShape is the exact output shape a refused submission must use.
func nodeTurnOutputShape(missing []string) string {
	parts := make([]string, 0, len(missing))
	for _, name := range missing {
		parts = append(parts, `"`+name+`":{"enable":true,"value":<value>}`)
	}
	return strings.Join(parts, ",")
}
