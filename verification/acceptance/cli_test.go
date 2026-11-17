package acceptance

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestHelpListsTheWholeCommandSurface(t *testing.T) {
	text, code := helpText(t)
	if code != 0 {
		t.Fatalf("verify-graph help exited %d; stdout+stderr: %s", code, text)
	}
	missing := []string{}
	for _, command := range commands {
		if !strings.Contains(text, command) {
			missing = append(missing, command)
		}
	}
	if len(missing) > 0 {
		t.Fatalf("help does not list %s\nhelp output:\n%s", strings.Join(missing, ", "), text)
	}
}

func TestDoctorPrintsAnActionableEnvelope(t *testing.T) {
	stdout, stderr, code := runCLI(t, "doctor", "--json")
	envelope := jsonObject(t, stdout)
	if _, ok := envelope["ok"].(bool); !ok {
		t.Fatalf("doctor envelope has no boolean ok: %v", envelope)
	}
	command, _ := envelope["command"].(string)
	if !strings.Contains(command, "doctor") {
		t.Fatalf("doctor envelope names command %q", command)
	}
	switch code {
	case 0, 3:
	default:
		t.Fatalf("doctor exited %d; it may only exit 0 (usable) or 3 (environment)\nstderr: %s", code, stderr)
	}
	if code == 0 && envelope["ok"] != true {
		t.Fatalf("doctor exited 0 with ok=false: %v", envelope)
	}
	if envelope["ok"] == false {
		if code != 3 {
			t.Fatalf("doctor failed with exit %d; environment failures exit 3", code)
		}
		if hintOf(envelope) == "" {
			t.Fatalf("failed doctor gives no executable next step (hint/next): %v", envelope)
		}
	}
}

func hintOf(envelope map[string]any) string {
	errorValue, _ := envelope["error"].(map[string]any)
	for _, key := range []string{"hint", "next", "nextAction", "suggestion"} {
		if value, _ := errorValue[key].(string); strings.TrimSpace(value) != "" {
			return value
		}
	}
	for _, key := range []string{"nextActions", "warnings"} {
		if values, _ := envelope[key].([]any); len(values) > 0 {
			if text, _ := values[0].(string); strings.TrimSpace(text) != "" {
				return text
			}
		}
	}
	return ""
}

func TestUnknownCommandIsAUsageError(t *testing.T) {
	stdout, stderr, code := runCLI(t, "definitely-not-a-command")
	if code != 2 {
		t.Fatalf("unknown command exited %d, want 2\nstdout: %s\nstderr: %s", code, stdout, stderr)
	}
	text := strings.TrimSpace(stdout)
	if text == "" {
		text = strings.TrimSpace(stderr)
	}
	var envelope map[string]any
	if err := json.Unmarshal([]byte(text), &envelope); err != nil {
		t.Fatalf("usage error is not JSON: %q", firstLine(text))
	}
	if envelope["ok"] != false {
		t.Fatalf("usage error envelope has ok=%v", envelope["ok"])
	}
	if hintOf(envelope) == "" {
		t.Fatalf("usage error gives no next step: %v", envelope)
	}
}
