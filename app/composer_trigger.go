package main

import (
	"net/url"
	"regexp"
	"strings"
	"unicode"
)

type composerTrigger struct {
	kind  string
	query string
	start int
	end   int
}

var (
	composerCommandLine    = regexp.MustCompile(`^/(\S*)$`)
	composerCurrencyAmount = regexp.MustCompile(`^\.?[0-9][0-9,._]*(?:[kKmMbBtT]|[eE][0-9]+)?[.,;:!?)]*$`)
)

func composerIsSpace(r rune) bool {
	return r == ' ' || r == '\n' || r == '\t' || r == '\r'
}

func composerClampCursor(runes []rune, cursor int) int {
	if cursor < 0 {
		return 0
	}
	if cursor > len(runes) {
		return len(runes)
	}
	return cursor
}

func composerPathWord(runes []rune, wordStart, cursor int) bool {
	wordEnd := cursor
	for wordEnd < len(runes) && !composerIsSpace(runes[wordEnd]) {
		wordEnd++
	}
	for index := wordStart + 1; index < wordEnd; index++ {
		if runes[index] == '/' || runes[index] == '\\' {
			return true
		}
	}
	return false
}

func detectComposerTrigger(text string, cursorInput int) *composerTrigger {
	runes := []rune(text)
	cursor := composerClampCursor(runes, cursorInput)
	lineStart := 0
	for index := cursor - 1; index >= 0; index-- {
		if runes[index] == '\n' {
			lineStart = index + 1
			break
		}
	}
	linePrefix := string(runes[lineStart:cursor])
	if strings.HasPrefix(linePrefix, "/") {
		if match := composerCommandLine.FindStringSubmatch(linePrefix); match != nil && !composerPathWord(runes, lineStart, cursor) {
			return &composerTrigger{kind: "command", query: match[1], start: lineStart, end: cursor}
		}
	}
	tokenStart := cursor
	for tokenStart > 0 && !composerIsSpace(runes[tokenStart-1]) {
		tokenStart--
	}
	token := string(runes[tokenStart:cursor])
	if token == "" {
		return nil
	}
	switch {
	case strings.HasPrefix(token, "/"):
		if composerPathWord(runes, tokenStart, cursor) {
			return nil
		}
		return &composerTrigger{kind: "command", query: token[1:], start: tokenStart, end: cursor}
	case strings.HasPrefix(token, "@"):
		return &composerTrigger{kind: "path", query: token[1:], start: tokenStart, end: cursor}
	}
	first := []rune(token)[0]
	if unicode.Is(unicode.Sc, first) {
		query := string([]rune(token)[1:])
		if composerCurrencyAmount.MatchString(query) {
			return nil
		}
		return &composerTrigger{kind: "skill", query: query, start: tokenStart, end: cursor}
	}
	return nil
}

func composerReplaceRange(text string, start, end int, replacement string) (string, int) {
	runes := []rune(text)
	if start < 0 {
		start = 0
	}
	if end > len(runes) {
		end = len(runes)
	}
	if end < start {
		end = start
	}
	next := string(runes[:start]) + replacement + string(runes[end:])
	return next, start + len([]rune(replacement))
}

func composerFileLink(path string) string {
	label := path
	if index := strings.LastIndexAny(path, "/\\"); index >= 0 {
		label = path[index+1:]
	}
	label = strings.NewReplacer(`\`, `\\`, `[`, `\[`, `]`, `\]`).Replace(label)
	destination := (&url.URL{Path: path}).EscapedPath()
	destination = strings.NewReplacer("(", "%28", ")", "%29", "#", "%23", "?", "%3F", `\`, "%5C").Replace(destination)
	return "[" + label + "](" + destination + ")"
}
