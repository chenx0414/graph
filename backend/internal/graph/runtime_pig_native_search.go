package graph

func pigNativeGrepLine(line string) string {
	runes := []rune(line)
	if len(runes) <= pigNativeGrepLineLength {
		return line
	}
	return string(runes[:pigNativeGrepLineLength]) + "…"
}
