package main

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
)

func chatForLayoutTest(t *testing.T, messages int, questions int) *shellState {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/conversations":
			w.Write([]byte(`[{"id":"c1","title":"13-Graph","projectId":"13-Graph","role":"project","archivedAt":null}]`))
		case "/api/conversations/c1":
			w.Write([]byte(`{"messages":[{"role":"user","text":"开始"}]}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(server.Close)
	state := newShellState(server.URL, "tok")
	state.load()
	chat := state.active()
	for index := 0; index < questions; index++ {
		chat.questions = append(chat.questions, openQuestion{
			ID: "q" + strconv.Itoa(index), Kind: "decision", Status: "open",
			Data: questionOptions{Prompt: "这一步要 A 还是 B？", Options: []string{"A", "B"}},
		})
	}
	for index := 0; index < messages; index++ {
		chat.messages = append(chat.messages, transcriptMessage{Role: "assistant", Kind: "chat", Text: "第 " + strconv.Itoa(index) + " 条消息内容"})
	}
	return state
}

func TestComposerIsVisibleWhateverTheTranscriptLength(t *testing.T) {
	for _, test := range []struct {
		name                string
		width, height       int
		messages, questions int
	}{
		{"the window the app opens at", 1373, 833, 6, 0},
		{"a transcript longer than the window", 1373, 833, 60, 12},
		{"a short window with a long transcript", 900, 600, 60, 12},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := chatForLayoutTest(t, test.messages, test.questions)
			tester := newTester(state.view, test.width, test.height)
			for frame := 0; frame < 3; frame++ {
				render(tester)
			}
			for _, label := range []string{"消息", "发送"} {
				rect, ok := tester.Find(label)
				if !ok {
					t.Fatalf("%s never rendered, texts %q", label, tester.Texts())
				}
				if rect.W == 0 || rect.H == 0 {
					t.Fatalf("%s has no size (%+v): the window is %dx%d", label, rect, test.width, test.height)
				}
				if bottom := rect.Y + rect.H; bottom > float32(test.height) {
					t.Fatalf("%s sits below the window: its bottom edge is %.1f of %d (%+v)",
						label, bottom, test.height, rect)
				}
			}
		})
	}
}
