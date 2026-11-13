package main

import (
	"regexp"
	"strings"

	"github.com/egoist/mygo/ui"
	"graph/app/gwui/palette"
)

type composerToken struct {
	kind  string
	start int
	end   int
}

var (
	composerFileToken    = regexp.MustCompile(`\[[^\]]+\]\([^)]+\)`)
	composerSkillToken   = regexp.MustCompile(`(^|[\s])\$([a-zA-Z0-9][a-zA-Z0-9:_-]*)([\s]|$)`)
	composerMentionToken = regexp.MustCompile(`(^|[\s])@[^\s]+`)
	composerCommandToken = regexp.MustCompile(`(?m)^/[a-zA-Z][a-zA-Z0-9_-]*$`)
	composerKernelSkill  = regexp.MustCompile(`/skill:[A-Za-z0-9._-]+`)
)

var (
	composerFileAccent    = palette.OKLCH{L: 0.62, C: 0.136, H: 237}.Color()
	composerMentionAccent = palette.OKLCH{L: 0.62, C: 0.11, H: 215}.Color()
	composerSkillAccent   = palette.OKLCH{L: 0.62, C: 0.16, H: 322}.Color()
	composerCommandAccent = palette.OKLCH{L: 0.62, C: 0.134, H: 163}.Color()
)

func composerRuneIndex(text string, byteIndex int) int {
	return len([]rune(text[:byteIndex]))
}

func composerTokens(draft string, skills map[string]bool) []composerToken {
	tokens := []composerToken{}
	add := func(kind string, start, end int) {
		tokens = append(tokens, composerToken{kind: kind, start: start, end: end})
	}
	for _, match := range composerFileToken.FindAllStringIndex(draft, -1) {
		add("file", composerRuneIndex(draft, match[0]), composerRuneIndex(draft, match[1]))
	}
	for _, match := range composerSkillToken.FindAllStringSubmatchIndex(draft, -1) {
		name := draft[match[4]:match[5]]
		if !skills[name] {
			continue
		}
		add("skill", composerRuneIndex(draft, match[4])-1, composerRuneIndex(draft, match[5]))
	}
	for _, match := range composerMentionToken.FindAllStringIndex(draft, -1) {
		start := match[0]
		for start < match[1] && strings.ContainsRune(" \t\n\r", rune(draft[start])) {
			start++
		}
		if start >= match[1] {
			continue
		}
		add("mention", composerRuneIndex(draft, start), composerRuneIndex(draft, match[1]))
	}
	for _, match := range composerKernelSkill.FindAllStringIndex(draft, -1) {
		add("skill", composerRuneIndex(draft, match[0]), composerRuneIndex(draft, match[1]))
	}
	for _, match := range composerCommandToken.FindAllStringIndex(draft, -1) {
		command := draft[match[0]+1 : match[1]]
		if command == "clear" || command == "attach" || command == "model" {
			add("command", composerRuneIndex(draft, match[0]), composerRuneIndex(draft, match[1]))
		}
	}
	return tokens
}

func composerTextRanges(tokens []composerToken) []ui.TextRange {
	ranges := make([]ui.TextRange, 0, len(tokens))
	for _, token := range tokens {
		textRange := ui.TextRange{Start: token.start, End: token.end, Weight: 500}
		switch token.kind {
		case "file":
			textRange.Color = composerFileAccent
		case "mention":
			textRange.Color = composerMentionAccent
		case "skill":
			textRange.Color = composerSkillAccent
			textRange.Weight = 600
		case "command":
			textRange.Color = composerCommandAccent
		}
		ranges = append(ranges, textRange)
	}
	return ranges
}

func (c *chatState) composerSkillNames() map[string]bool {
	names := make(map[string]bool, len(c.skillItems))
	for _, skill := range c.skillItems {
		if skill.Name != "" {
			names[skill.Name] = true
		}
	}
	return names
}
