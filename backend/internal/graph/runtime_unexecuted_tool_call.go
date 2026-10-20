package graph

import "regexp"

// A provider may emit its tool-call wire format as ordinary assistant text.
// Match both observed parameter-opening variants by their complete closing sequence.
// A fenced example is documentation, not a request to execute a tool.

var unexecutedFence = regexp.MustCompile("(?s)```.*?```|~~~.*?~~~")
var unexecutedDSML = regexp.MustCompile(`(?s)<parameter\s+name="[\w.-]+">.*</｜DSML｜\s+parameter>\s*</｜DSML｜\s+invoke>\s*</｜DSML｜\s+calls>\s*$`)
var unexecutedInvoke = regexp.MustCompile(`(?s)<parameter\s+name="[\w.-]+">.*<parameter\s+name="[\w.-]+">.*</parameter>\s*</invoke>\s*(?:</analysis>)?\s*$`)
var unexecutedParam = regexp.MustCompile(`(?s)<parameter\s+name="[\w.-]+">.*?</parameter>`)
var unexecutedParamStart = regexp.MustCompile(`<parameter\s+name="[\w.-]+">`)

func HasUnexecutedToolCall(text string) bool {
	prose := unexecutedFence.ReplaceAllString(text, "")
	if unexecutedDSML.MatchString(prose) || unexecutedInvoke.MatchString(prose) {
		return true
	}
	// Some OpenAI-compatible providers emit only parameter tags, even for
	// several attempted calls. Two closed fields distinguish this from prose
	// mentioning a single parameter tag.
	return len(unexecutedParam.FindAllString(prose, -1)) >= 2
}

// WithoutUnexecutedToolCall keeps narration before a leaked call; its parameter text was never executed.
func WithoutUnexecutedToolCall(text string) string {
	if !HasUnexecutedToolCall(text) {
		return text
	}
	unfenced := unexecutedFence.ReplaceAllStringFunc(text, func(match string) string {
		return repeatSpace(len(match))
	})
	loc := unexecutedParamStart.FindStringIndex(unfenced)
	if loc == nil {
		return text
	}
	return trimEndSpace(text[:loc[0]]) + "\n[Unexecuted tool-call text omitted.]"
}

func repeatSpace(n int) string {
	if n <= 0 {
		return ""
	}
	return string(bytesRepeat(' ', n))
}

func bytesRepeat(b byte, n int) []byte {
	out := make([]byte, n)
	for i := range out {
		out[i] = b
	}
	return out
}

func trimEndSpace(s string) string {
	i := len(s)
	for i > 0 {
		c := s[i-1]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' && c != '\v' && c != '\f' {
			break
		}
		i--
	}
	return s[:i]
}
