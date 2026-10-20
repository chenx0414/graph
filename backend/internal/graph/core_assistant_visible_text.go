package graph

import (
	"regexp"
	"strings"
)

// Private response dialect markers observed in ordinary provider text.
var (
	privateTagOpen  = regexp.MustCompile(`(?i)<(analysis|review[\s_]*of[\s_]*last[\s_]*turn)>`)
	privateTagClose = regexp.MustCompile(`(?i)</(?:analysis|review[\s_]*of[\s_]*last[\s_]*turn)>`)
	fencedBlock     = regexp.MustCompile("(?s)```[\\s\\S]*?```|~~~[\\s\\S]*?~~~")
)

// HasPrivateMarkup reports whether ordinary text contains an internal marker outside fenced examples.
func HasPrivateMarkup(text string) bool {
	stripped := fencedBlock.ReplaceAllString(text, "")
	return privateTagOpen.MatchString(stripped)
}

// AssistantVisibleText removes private markup emitted as ordinary assistant text. Fenced examples stay visible.
func AssistantVisibleText(text string) string {
	var b strings.Builder
	last := 0
	for _, loc := range fencedBlock.FindAllStringIndex(text, -1) {
		b.WriteString(stripPrivateMarkup(text[last:loc[0]]))
		b.WriteString(text[loc[0]:loc[1]])
		last = loc[1]
	}
	b.WriteString(stripPrivateMarkup(text[last:]))
	return b.String()
}

func stripPrivateMarkup(part string) string {
	part = stripPairedPrivate(part)
	if loc := privateTagOpen.FindStringIndex(part); loc != nil {
		part = part[:loc[0]]
	}
	return privateTagClose.ReplaceAllString(part, "")
}

func stripPairedPrivate(part string) string {
	for {
		loc := privateTagOpen.FindStringSubmatchIndex(part)
		if loc == nil {
			return part
		}
		tag := part[loc[2]:loc[3]]
		rest := part[loc[1]:]
		closeAt := indexFoldClose(rest, tag)
		if closeAt < 0 {
			return part
		}
		part = part[:loc[0]] + rest[closeAt:]
	}
}

func indexFoldClose(text, tag string) int {
	lower := strings.ToLower(text)
	needle := "</" + strings.ToLower(tag) + ">"
	at := strings.Index(lower, needle)
	if at < 0 {
		return -1
	}
	return at + len(needle)
}
