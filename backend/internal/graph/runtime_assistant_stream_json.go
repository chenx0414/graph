package graph

import (
	"fmt"
	"regexp"
	"strings"

	"encoding/json"
)

func ParseStreamingJSON(text string) any {
	if strings.TrimSpace(text) == "" {
		return map[string]any{}
	}
	if value, ok := decodeJSONValue(text); ok {
		return value
	}
	repaired := repairStreamingJSON(text)
	if value, ok := decodeJSONValue(repaired); ok {
		return value
	}
	if value, ok := partialJSONValue(repaired); ok {
		return value
	}
	return map[string]any{}
}

func decodeJSONValue(text string) (any, bool) {
	var value any
	if err := json.Unmarshal([]byte(text), &value); err != nil {
		return nil, false
	}
	return value, true
}

var validJSONEscapes = map[rune]bool{
	'"': true, '\\': true, '/': true, 'b': true, 'f': true, 'n': true, 'r': true, 't': true, 'u': true,
}

var unicodeEscapePattern = regexp.MustCompile(`^[0-9a-fA-F]{4}$`)

func repairStreamingJSON(text string) string {
	var b strings.Builder
	runes := []rune(text)
	inString := false
	for index := 0; index < len(runes); index++ {
		character := runes[index]
		if !inString {
			b.WriteRune(character)
			if character == '"' {
				inString = true
			}
			continue
		}
		if character == '"' {
			b.WriteRune(character)
			inString = false
			continue
		}
		if character == '\\' {
			if index+1 >= len(runes) {
				b.WriteString("\\\\")
				continue
			}
			next := runes[index+1]
			if next == 'u' {
				if index+5 < len(runes) {
					digits := string(runes[index+2 : index+6])
					if unicodeEscapePattern.MatchString(digits) {
						b.WriteString("\\u")
						b.WriteString(digits)
						index += 5
						continue
					}
				}
			}
			if validJSONEscapes[next] {
				b.WriteRune('\\')
				b.WriteRune(next)
				index++
				continue
			}
			b.WriteString("\\\\")
			continue
		}
		if isControlCharacter(character) {
			b.WriteString(escapeControlCharacter(character))
			continue
		}
		b.WriteRune(character)
	}
	return b.String()
}

func isControlCharacter(character rune) bool {
	return character >= 0x00 && character <= 0x1f
}

func escapeControlCharacter(character rune) string {
	switch character {
	case '\b':
		return "\\b"
	case '\f':
		return "\\f"
	case '\n':
		return "\\n"
	case '\r':
		return "\\r"
	case '\t':
		return "\\t"
	}
	return fmt.Sprintf("\\u%04x", character)
}
