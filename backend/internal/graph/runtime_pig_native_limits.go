package graph

import (
	"strings"

	"fmt"
)

const (
	pigNativeLsLimit        = 500
	pigNativeFindLimit      = 1000
	pigNativeGrepLimit      = 100
	pigNativeMaxBytes       = 50 * 1024
	pigNativeMaxLines       = 2000
	pigNativeGrepLineLength = 500
)

func pigNativeLimit(value any, fallback int) int {
	requested := pigNativeNumber(value)
	if requested <= 0 {
		return fallback
	}
	return requested
}

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
