package graph

import (
	"strings"

	"encoding/json"
)

type jsonScanState struct {
	stack       []byte
	inString    bool
	stringStart int
}

func scanJSONPrefix(text string) jsonScanState {
	state := jsonScanState{}
	for index := 0; index < len(text); index++ {
		character := text[index]
		if state.inString {
			if character == '\\' {
				index++
				continue
			}
			if character == '"' {
				state.inString = false
			}
			continue
		}
		switch character {
		case '"':
			state.inString = true
			state.stringStart = index
		case '{':
			state.stack = append(state.stack, '{')
		case '[':
			state.stack = append(state.stack, '[')
		case '}', ']':
			if len(state.stack) > 0 {
				state.stack = state.stack[:len(state.stack)-1]
			}
		}
	}
	return state
}

func partialJSONValue(text string) (any, bool) {
	base := strings.TrimRight(text, " \t\r\n")
	for _, candidate := range partialJSONCandidates(base) {
		closed, ok := closeJSONContainers(candidate)
		if !ok {
			continue
		}
		var value any
		if err := json.Unmarshal([]byte(closed), &value); err != nil {
			continue
		}
		return value, true
	}
	return nil, false
}

func partialJSONCandidates(base string) []string {
	candidates := []string{base}
	state := scanJSONPrefix(base)
	if state.inString {
		candidates = append(candidates, base+`"`)
		candidates = append(candidates, dropTrailingString(base, state.stringStart))
	}
	trimmed := strings.TrimRight(base, " \t\r\n")
	if strings.HasSuffix(trimmed, ":") {
		without := strings.TrimRight(trimmed[:len(trimmed)-1], " \t\r\n")
		candidates = append(candidates, without)
		if start, ok := lastStringStart(without); ok {
			candidates = append(candidates, dropTrailingString(without, start))
		}
	}
	if strings.HasSuffix(trimmed, ",") {
		candidates = append(candidates, strings.TrimRight(trimmed[:len(trimmed)-1], " \t\r\n"))
	}
	return candidates
}

func dropTrailingString(text string, start int) string {
	trimmed := strings.TrimRight(text[:start], " \t\r\n")
	if strings.HasSuffix(trimmed, ",") {
		trimmed = strings.TrimRight(trimmed[:len(trimmed)-1], " \t\r\n")
	}
	return trimmed
}

func lastStringStart(text string) (int, bool) {
	for index := len(text) - 1; index >= 0; index-- {
		if text[index] != '"' {
			continue
		}
		backslashes := 0
		for cursor := index - 1; cursor >= 0 && text[cursor] == '\\'; cursor-- {
			backslashes++
		}
		if backslashes%2 != 0 {
			continue
		}
		start := index
		for start > 0 {
			previous := start - 1
			backslashes := 0
			for cursor := previous - 1; cursor >= 0 && text[cursor] == '\\'; cursor-- {
				backslashes++
			}
			if backslashes%2 != 0 {
				break
			}
			if text[previous] != '"' {
				break
			}
			start = previous
		}
		return start, true
	}
	return 0, false
}

func closeJSONContainers(text string) (string, bool) {
	state := scanJSONPrefix(text)
	closed := text
	for index := len(state.stack) - 1; index >= 0; index-- {
		if state.stack[index] == '{' {
			closed += "}"
			continue
		}
		closed += "]"
	}
	return closed, true
}
