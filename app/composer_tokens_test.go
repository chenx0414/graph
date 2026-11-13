package main

import (
	"testing"
)

func TestComposerTokensFindFilesSkillsMentionsAndCommands(t *testing.T) {
	draft := "看 [graph.go](app/graph.go) 和 $tdd-workflow 还有 @app/g\n/clear"
	tokens := composerTokens(draft, map[string]bool{"tdd-workflow": true})
	want := []struct {
		kind  string
		text  string
		start int
		end   int
	}{
		{"file", "[graph.go](app/graph.go)", 2, 26},
		{"skill", "$tdd-workflow", 29, 42},
		{"mention", "@app/g", 46, 52},
		{"command", "/clear", 53, 59},
	}
	if len(tokens) != len(want) {
		t.Fatalf("tokens %+v, want %d", tokens, len(want))
	}
	runes := []rune(draft)
	for index, expected := range want {
		got := tokens[index]
		if got.kind != expected.kind || got.start != expected.start || got.end != expected.end {
			t.Fatalf("token %d is %+v, want %+v", index, got, expected)
		}
		if string(runes[got.start:got.end]) != expected.text {
			t.Fatalf("token %d covers %q, want %q", index, string(runes[got.start:got.end]), expected.text)
		}
	}
}

func TestComposerTokensSkipMoneyUnknownSkillsAndPlainSlashWords(t *testing.T) {
	for _, draft := range []string{"$5", "$10k.", "$nope", "a / b", "src/main.go"} {
		if tokens := composerTokens(draft, map[string]bool{"nope": false}); len(tokens) != 0 {
			t.Fatalf("%q must stay plain text, tokens %+v", draft, tokens)
		}
	}
}

func TestComposerTokensColorByKind(t *testing.T) {
	draft := "看 [graph.go](app/graph.go) 和 $tdd-workflow 还有 @app/g\n/clear"
	ranges := composerTextRanges(composerTokens(draft, map[string]bool{"tdd-workflow": true}))
	if len(ranges) != 4 {
		t.Fatalf("ranges %+v", ranges)
	}
	colors := map[[4]uint8]bool{}
	for _, textRange := range ranges {
		colors[[4]uint8{textRange.Color.R, textRange.Color.G, textRange.Color.B, textRange.Color.A}] = true
	}
	if len(colors) != 4 {
		t.Fatalf("each token kind keeps its own color, colors %v", colors)
	}
	if ranges[1].Weight < 600 {
		t.Fatalf("skill tokens read as chips, weight %d", ranges[1].Weight)
	}
}
