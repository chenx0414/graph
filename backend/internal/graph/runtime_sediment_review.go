package graph

// The review itself: one conversation with a model that reads the
// run and says what it learned.
//
// The answer is text, and the helpers here read the pieces of it that
// the proposal needs.
import (
	"encoding/json"
	"strings"
)

type SedimentOutcome struct {
	Nothing  bool              `json:"nothing"`
	Written  []SedimentWritten `json:"written"`
	Refused  []string          `json:"refused"`
	Proposed *string           `json:"proposed"`
}

func escapeControlCharacters(value string) string {
	var out strings.Builder
	for _, char := range value {
		switch char {
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if char >= 0 && char <= 0x1f {
				out.WriteString(`\u`)
				hex := "0123456789abcdef"
				out.WriteByte(hex[(char>>12)&0xf])
				out.WriteByte(hex[(char>>8)&0xf])
				out.WriteByte(hex[(char>>4)&0xf])
				out.WriteByte(hex[char&0xf])
				continue
			}
			out.WriteRune(char)
		}
	}
	return out.String()
}

func firstJsonObject(text string) string {
	start := strings.IndexByte(text, '{')
	if start < 0 {
		return ""
	}
	depth := 0
	quoted := false
	escaped := false
	for index := start; index < len(text); index++ {
		char := text[index]
		if quoted {
			if escaped {
				escaped = false
			} else if char == '\\' {
				escaped = true
			} else if char == '"' {
				quoted = false
			}
			continue
		}
		if char == '"' {
			quoted = true
			continue
		}
		if char == '{' {
			depth++
		} else if char == '}' {
			depth--
			if depth == 0 {
				return text[start : index+1]
			}
		}
	}
	return ""
}

// SedimentReplyShape records what the parser saw in a review reply.

type SedimentReplyShape struct {
	MetadataLine bool   `json:"metadataLine"`
	Fence        bool   `json:"fence"`
	Chars        int    `json:"chars"`
	Tail         string `json:"tail"`
}

// SedimentReplyShapeOf describes an unreadable review without discarding the shape.

func SedimentReplyShapeOf(text string) SedimentReplyShape {
	raw := strings.TrimSpace(text)
	tail := raw
	runes := []rune(raw)
	if len(runes) > 200 {
		tail = string(runes[len(runes)-200:])
	}
	return SedimentReplyShape{MetadataLine: firstJsonObject(raw) != "", Fence: sedimentFence.MatchString(raw), Chars: len(text), Tail: tail}
}

// ParseSedimentProposal reads a proposal out of a model reply.

type SedimentReply struct {
	Text       *string
	Raw        string
	StopReason *string
	Error      *string
}

// SedimentStream is the injected model call. It receives the plain context; the
// controlled adapter folds it into the transcript the way the Pi SDK's
// normalizeContext does.

type SedimentStream func(model any, context map[string]any, options map[string]any) (message map[string]any, err error)

// GenerateSkillProposal asks one model for a skill document. The transcript crosses as data.

func sedimentTextFromMessage(message map[string]any) string {
	parts, ok := message["content"].([]any)
	if !ok {
		return ""
	}
	var out strings.Builder
	for _, part := range parts {
		record, ok := part.(map[string]any)
		if !ok {
			continue
		}
		if record["type"] == "text" {
			if text, ok := record["text"].(string); ok {
				out.WriteString(text)
			}
		}
	}
	return out.String()
}

// RunSedimentReview gates, asks, parses and applies one review.

func RunSedimentReview(gate SedimentGate, settings SedimentSettings, projectRoot string, review func() *string) struct {
	Reviewed bool
	Outcome  SedimentOutcome
} {
	gate.Enabled = gate.Enabled && settings.Enabled
	gate.Threshold = settings.AfterToolCalls
	if !ShouldSediment(gate) {
		return struct {
			Reviewed bool
			Outcome  SedimentOutcome
		}{Reviewed: false, Outcome: sedimentNothing()}
	}
	reply := ""
	if text := review(); text != nil {
		reply = *text
	}
	return struct {
		Reviewed bool
		Outcome  SedimentOutcome
	}{Reviewed: true, Outcome: ApplySedimentProposal(projectRoot, ParseSedimentProposal(reply))}
}

func panicText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(
		strings.TrimPrefix(strings.TrimPrefix(jsonQuote(rec), `"`), `"`), "\n", " "), `"`, ""))
}

func jsonQuote(value any) string {
	encoded, err := json.Marshal(value)
	if err != nil {
		return ""
	}
	return string(encoded)
}
