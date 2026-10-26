package graph

// pigNativeGrepLine cuts one matching line to the length a search answer
// carries. A line of a generated file can be megabytes long, and one such
// line is enough to fill the answer.
func pigNativeGrepLine(line string) string {
	runes := []rune(line)
	if len(runes) <= pigNativeGrepLineLength {
		return line
	}
	return string(runes[:pigNativeGrepLineLength]) + "…"
}
