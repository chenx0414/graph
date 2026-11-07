package graph

import (
	"strings"
	"testing"
)

func TestAsyncFullNoticeIsReadableAndCarriesNoEscapeCodes(t *testing.T) {
	output := "\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m tests/e2e/desktop-shell.test.ts > OpenRouter authorization\n" +
		"\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m3 failed\x1b[39m\x1b[22m (251)\n" +
		"check:tests: 3 file(s) failed twice, so the gate stops here:\n" +
		"  - tests/e2e/desktop-crash-recovery.test.ts [assertion]\n"

	summary := rsiAsyncFullSummary(output)
	notice := rsiAsyncFullNotice("6549520f", "回归", summary, "/tmp/async-full.log")

	if strings.Contains(notice, "\x1b[") {
		t.Fatalf("the notice still carries terminal escape codes:\n%s", notice)
	}
	if lines := strings.Count(notice, "\n") + 1; lines > 8 {
		t.Fatalf("the notice is %d lines, more than a chat message can read", lines)
	}
	for _, want := range []string{"6549520f", "回归", "desktop-shell.test.ts", "/tmp/async-full.log"} {
		if !strings.Contains(notice, want) {
			t.Fatalf("the notice does not mention %q:\n%s", want, notice)
		}
	}
}
