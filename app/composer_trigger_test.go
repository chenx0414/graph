package main

import (
	"testing"
	"unicode/utf8"
)

func TestComposerTriggerReadsMentionsSkillsAndCommands(t *testing.T) {
	cases := []struct {
		text   string
		cursor int
		kind   string
		query  string
		start  int
		end    int
	}{
		{"@", 1, "path", "", 0, 1},
		{"看看 @app/g", 9, "path", "app/g", 3, 9},
		{"$tdd", 4, "skill", "tdd", 0, 4},
		{"/clear", 6, "command", "clear", 0, 6},
		{"先说 /mod", 7, "command", "mod", 3, 7},
		{"第一行\n@do", 7, "path", "do", 4, 7},
		{"@", 0, "", "", 0, 0},
	}
	for _, want := range cases {
		got := detectComposerTrigger(want.text, want.cursor)
		if want.kind == "" {
			if got != nil {
				t.Fatalf("%q must not open a menu, got %+v", want.text, got)
			}
			continue
		}
		if got == nil {
			t.Fatalf("%q misses its trigger", want.text)
		}
		if got.kind != want.kind || got.query != want.query || got.start != want.start || got.end != want.end {
			t.Fatalf("%q -> %+v, want kind %q query %q range %d-%d", want.text, got, want.kind, want.query, want.start, want.end)
		}
	}
}

func TestComposerTriggerIgnoresMoneyAndPaths(t *testing.T) {
	for _, text := range []string{"$5", "$10k.", "$1,000", "(€9.99)", "/usr/local/bin", "src/main.go"} {
		if got := detectComposerTrigger(text, len(text)); got != nil {
			t.Fatalf("%q must not open a menu, got %+v", text, got)
		}
	}
}

func TestComposerTriggerReplacesItsRange(t *testing.T) {
	draft := "看看 @app/g 的图"
	trigger := detectComposerTrigger(draft, 9)
	if trigger == nil {
		t.Fatal("the mention trigger never fired")
	}
	replaced, cursor := composerReplaceRange(draft, trigger.start, trigger.end, "[graph.go](app/graph.go)")
	if replaced != "看看 [graph.go](app/graph.go) 的图" {
		t.Fatalf("the mention replaced %q", replaced)
	}
	if cursor != utf8.RuneCountInString("看看 [graph.go](app/graph.go)") {
		t.Fatalf("the cursor lands after the mention, got %d", cursor)
	}
}

func TestComposerFileLinkSerializesTheBasename(t *testing.T) {
	if got := composerFileLink("app/graph.go"); got != "[graph.go](app/graph.go)" {
		t.Fatalf("the file link is %q", got)
	}
	if got := composerFileLink("docs/a b.md"); got != "[a b.md](docs/a%20b.md)" {
		t.Fatalf("the file link encodes spaces, got %q", got)
	}
}
