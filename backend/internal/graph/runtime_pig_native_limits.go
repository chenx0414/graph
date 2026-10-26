package graph

import (
	"strings"

	"fmt"
)

const (
	// pigNativeLsLimit is how many entries a listing returns by default.
	pigNativeLsLimit = 500
	// pigNativeFindLimit is how many matches a file search returns by default.
	pigNativeFindLimit = 1000
	// pigNativeGrepLimit is how many matches a content search returns by default.
	pigNativeGrepLimit = 100
	// pigNativeMaxBytes is how large one tool answer may be.
	pigNativeMaxBytes = 50 * 1024
	// pigNativeMaxLines is how many lines a file read returns.
	pigNativeMaxLines = 2000
	// pigNativeGrepLineLength is how long one matching line may be.
	pigNativeGrepLineLength = 500
)

// pigNativeLimit reads the limit one call asked for, or the default.
//
// A caller that asks for no limit gets the default, and a caller that asks
// for a limit of its own gets it: the tool is the model's to narrow, and the
// default is the ceiling the model has to ask past.
func pigNativeLimit(value any, fallback int) int {
	requested := pigNativeNumber(value)
	if requested <= 0 {
		return fallback
	}
	return requested
}

// pigNativeRender joins the lines one native tool returns.
//
// The answer never exceeds the byte budget, and it says what it left out and
// how to see more. A truncated answer that looks like a whole one is worse
// than no answer: the model believes it has seen the directory.
//
// The notice comes first. The kernel truncates a tool answer once more, from
// the head, so a notice at the end of an answer that fills the budget would
// be the part that goes.
func pigNativeRender(lines []string, notices []string) string {
	text := strings.Join(lines, "\n")
	if len(text) > pigNativeMaxBytes {
		cut := text[:pigNativeMaxBytes]
		if end := strings.LastIndex(cut, "\n"); end > 0 {
			cut = cut[:end]
		}
		text = strings.ToValidUTF8(cut, "")
		notices = append(notices, fmt.Sprintf("%s limit reached", pigNativeFormatBytes(pigNativeMaxBytes)))
	}
	if len(notices) > 0 {
		text = "[" + strings.Join(notices, ". ") + "]\n\n" + text
	}
	return text
}

// pigNativeFormatBytes is the size one number of bytes reads as.
func pigNativeFormatBytes(bytes int) string {
	switch {
	case bytes < 1024:
		return fmt.Sprintf("%dB", bytes)
	case bytes < 1024*1024:
		return fmt.Sprintf("%.1fKB", float64(bytes)/1024)
	default:
		return fmt.Sprintf("%.1fMB", float64(bytes)/(1024*1024))
	}
}

// pigNativeReadText cuts the lines one read returns.
//
// The answer is bounded the way the SDK bounds it: at most 2000 lines and at
// most 50KB, and it says which lines it showed and how to reach the next
// ones. A read that stops silently reads like a whole file.
func pigNativeReadText(text string, offset, limit int) string {
	lines := strings.Split(text, "\n")
	total := len(lines)
	first := offset
	if first < 1 {
		first = 1
	}
	if first > total {
		return ""
	}
	lines = lines[first-1:]
	if limit > 0 && limit < len(lines) {
		lines = lines[:limit]
	}
	if len(lines) > pigNativeMaxLines {
		lines = lines[:pigNativeMaxLines]
	}
	shown := len(lines)
	answer := strings.Join(lines, "\n")
	notices := []string{}
	if len(answer) > pigNativeMaxBytes {
		cut := answer[:pigNativeMaxBytes]
		if end := strings.LastIndex(cut, "\n"); end > 0 {
			cut = cut[:end]
		}
		answer = strings.ToValidUTF8(cut, "")
		notices = append(notices, fmt.Sprintf("%s limit reached", pigNativeFormatBytes(pigNativeMaxBytes)))
	}
	if first+shown-1 < total {
		notices = append(notices, fmt.Sprintf("Showing lines %d-%d of %d. Use offset=%d to continue",
			first, first+shown-1, total, first+shown))
	}
	if len(notices) > 0 {
		answer = "[" + strings.Join(notices, ". ") + "]\n\n" + answer
	}
	return answer
}
