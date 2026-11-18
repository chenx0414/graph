package eval

func AllCases(repository string) []Case {
	collected := []Case{}
	collected = append(collected, graphCases(repository)...)
	collected = append(collected, threadCases(repository)...)
	collected = append(collected, mainCases(repository)...)
	collected = append(collected, rsiCases()...)
	collected = append(collected, sandboxCases()...)
	return collected
}
