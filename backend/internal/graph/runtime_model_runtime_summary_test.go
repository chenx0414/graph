package graph

import "testing"

// A code mode row has to say what the script did. The recorded summary used to
// be the tool name itself, so the transcript showed "codemode: codemode" and
// the person reading it could not tell one script from another.
func TestCodemodeSummaryIsTheScriptsFirstLine(t *testing.T) {
	script := "// @options: {\"timeout_ms\": 5000}\n\nconst r = await tools.ls({ path: '.' });\ntext(r);"
	got := summarizeToolCall("codemode", map[string]any{"code": script})
	want := "const r = await tools.ls({ path: '.' });"
	if got != want {
		t.Fatalf("summary %q, want %q", got, want)
	}
}

func TestCodemodeSummaryIsBounded(t *testing.T) {
	script := "const value = " + string(make([]byte, 0)) + "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	got := summarizeToolCall("codemode", map[string]any{"code": script})
	if len([]rune(got)) > 120 {
		t.Fatalf("the summary has to stay readable, got %d runes", len([]rune(got)))
	}
}
