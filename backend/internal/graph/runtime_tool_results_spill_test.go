// graph:table-writes-exempt: no table is written by this test
package graph

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRenderToolResultWritesTheWholeTextBeforeItAdvertisesTheHandle(t *testing.T) {
	spillDir := filepath.Join(t.TempDir(), "tool-results")
	lines := make([]string, 8000)
	for index := range lines {
		lines[index] = "line-" + itoa(index)
	}
	text := strings.Join(lines, "\n")
	tracker := CreateToolResultTracker(MAX_SPILL_FILES, nil)
	limit := SHELL_OUTPUT_LIMIT
	summary := RenderToolResult(text, "conversation", "bash", map[string]any{"command": "print lines"}, spillDir, tracker, &limit, nil)
	handle := ""
	for _, line := range strings.Split(summary, "\n") {
		if strings.HasPrefix(line, "handle: ") {
			handle = strings.TrimSpace(strings.TrimPrefix(line, "handle: "))
		}
	}
	if handle == "" {
		t.Fatalf("the summary advertises no handle: %q", summary)
	}
	spilled, err := os.ReadFile(handle)
	if err != nil {
		t.Fatalf("the advertised handle cannot be read: %v", err)
	}
	if string(spilled) != text {
		t.Fatalf("the handle holds %d of %d characters, so the model was given a handle to a partial result", len(spilled), len(text))
	}
	entries, err := os.ReadDir(spillDir)
	if err != nil {
		t.Fatalf("read spill dir: %v", err)
	}
	for _, entry := range entries {
		if strings.Contains(entry.Name(), ".tmp") {
			t.Fatalf("the spill directory kept a temporary file %q, so a reader can still find a partial write", entry.Name())
		}
	}
}

func TestRenderToolResultKeepsTheTextByteForByteOnARepeat(t *testing.T) {
	spillDir := filepath.Join(t.TempDir(), "tool-results")
	text := strings.Repeat("payload line\n", 2000)
	tracker := CreateToolResultTracker(MAX_SPILL_FILES, nil)
	params := map[string]any{"command": "repeat"}
	limit := SHELL_OUTPUT_LIMIT
	first := RenderToolResult(text, "conversation", "bash", params, spillDir, tracker, &limit, nil)
	second := RenderToolResult(text, "conversation", "bash", params, spillDir, tracker, &limit, nil)
	if !strings.Contains(first, "handle: ") || !strings.Contains(second, "handle: ") {
		t.Fatalf("a repeated result was carried instead of spilled: %q", second)
	}
	handle := ""
	for _, line := range strings.Split(second, "\n") {
		if strings.HasPrefix(line, "handle: ") {
			handle = strings.TrimSpace(strings.TrimPrefix(line, "handle: "))
		}
	}
	spilled, err := os.ReadFile(handle)
	if err != nil {
		t.Fatalf("read the second handle: %v", err)
	}
	if string(spilled) != text {
		t.Fatalf("the rewrite left %d of %d characters", len(spilled), len(text))
	}
}
