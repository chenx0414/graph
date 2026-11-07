package graph

import "strings"

func nodeTurnOutputShape(missing []string) string {
	parts := make([]string, 0, len(missing))
	for _, name := range missing {
		parts = append(parts, `"`+name+`":{"enable":true,"value":<value>}`)
	}
	return strings.Join(parts, ",")
}
