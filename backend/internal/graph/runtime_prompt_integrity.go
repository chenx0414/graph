package graph

import (
	"os"
	"path/filepath"
	"strings"

	"encoding/json"
)

// PROMPT_SECTIONS are Graph's own sections plus the working directory the session appends.
var PROMPT_SECTIONS = []string{"<identity>", "<rules>", "<cwd>"}

type PromptIntegrity struct {
	Checked bool     `json:"checked"`
	OK      bool     `json:"ok"`
	Missing []string `json:"missing"`
}

func PromptIntegrityCheck(text *string, expected []string) PromptIntegrity {
	if expected == nil {
		expected = PROMPT_SECTIONS
	}
	if text == nil {
		return PromptIntegrity{Checked: false, OK: true, Missing: []string{}}
	}
	missing := []string{}
	for _, section := range expected {
		if !strings.Contains(*text, section) {
			missing = append(missing, section)
		}
	}
	return PromptIntegrity{Checked: true, OK: len(missing) == 0, Missing: missing}
}

// ReportPromptIntegrity checks one outgoing prompt and, when a part is missing, appends a line.
// Never panics: a diagnostic must not break a send.
func ReportPromptIntegrity(stateDir, operationID string, text *string, expected []string) PromptIntegrity {
	result := PromptIntegrityCheck(text, expected)
	if result.Checked && !result.OK {
		chars := 0
		if text != nil {
			chars = len(*text)
		}
		line, err := json.Marshal(map[string]any{
			"at":          NowMillis(),
			"operationId": operationID,
			"missing":     result.Missing,
			"characters":  chars,
		})
		if err == nil {
			f, openErr := os.OpenFile(filepath.Join(stateDir, "prompt-integrity.log"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
			if openErr == nil {
				_, _ = f.Write(append(line, '\n'))
				_ = f.Close()
			}
		}
	}
	return result
}
