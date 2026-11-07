package graph

import (
	"regexp"
	"sort"
)

var ruleSeedId = regexp.MustCompile(`(?m)^-\s*(R\d+)\b`)

func (library *AgentContextLibrary) RuleSeedGaps() []string {
	if library == nil {
		return nil
	}
	shipped := map[string]bool{}
	for _, text := range []string{DEFAULT_COMMON_RULES, DEFAULT_MAIN_RULES, DEFAULT_WORKER_RULES, DEFAULT_REVIEWER_RULES} {
		for _, match := range ruleSeedId.FindAllStringSubmatch(text, -1) {
			shipped[match[1]] = true
		}
	}
	effective := map[string]bool{}
	for _, key := range []AgentPromptKey{"rules/common.md", "rules/main.md", "rules/worker.md", "rules/reviewer.md"} {
		text, err := library.Prompt(key)
		if err != nil {
			continue
		}
		for _, match := range ruleSeedId.FindAllStringSubmatch(text, -1) {
			effective[match[1]] = true
		}
	}
	gaps := []string{}
	for id := range shipped {
		if !effective[id] {
			gaps = append(gaps, id)
		}
	}
	sort.Strings(gaps)
	return gaps
}
