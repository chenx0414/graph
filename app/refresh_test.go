package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestChatStatePollPicksUpAReplyThatArrivedLater(t *testing.T) {
	var replies atomic.Int32
	replies.Store(1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/conversations/c1" {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		if replies.Load() == 1 {
			w.Write([]byte(`{"messages":[{"role":"user","text":"开始"}]}`))
			return
		}
		w.Write([]byte(`{"messages":[{"role":"user","text":"开始"},{"role":"assistant","text":"回答到了"}]}`))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if len(state.messages) != 1 {
		t.Fatalf("opened with %d messages", len(state.messages))
	}
	if state.poll() {
		t.Fatal("a poll with no new reply must report no change")
	}
	replies.Store(2)
	if !state.poll() {
		t.Fatal("a reply that arrived after the window opened must be reported as a change")
	}
	if len(state.messages) != 2 || state.messages[1].Text != "回答到了" {
		t.Fatalf("the poll did not pick the reply up: %+v", state.messages)
	}
	if state.messages[0].Text != "开始" {
		t.Fatalf("a poll must keep the earlier messages, messages %+v", state.messages)
	}
}

func TestChatStatePollReportsChangesInPausedAndQuestions(t *testing.T) {
	var body atomic.Value
	body.Store(`{"messages":[{"role":"user","text":"开始"}],"paused":false}`)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(body.Load().(string)))
	}))
	defer server.Close()

	state := newChatState(server.URL, "tok")
	state.open("c1")
	if state.poll() {
		t.Fatal("unchanged state must not ask for a redraw")
	}
	body.Store(`{"messages":[{"role":"user","text":"开始"}],"paused":true}`)
	if !state.poll() || !state.paused {
		t.Fatalf("a pause must be reported and applied: changed=%v paused=%v", state.poll(), state.paused)
	}
	body.Store(`{"messages":[{"role":"user","text":"开始"}],"paused":true,"questions":[{"id":"q1","kind":"decision","status":"open","data":{"prompt":"选 A 还是 B","options":["A","B"]}}]}`)
	if !state.poll() || len(state.questions) != 1 {
		t.Fatalf("a new question must be reported and applied: %+v", state.questions)
	}
}

func TestExecutableReplaced(t *testing.T) {
	base := fileStamp{Size: 100, Mod: time.Unix(1_700_000_000, 0), Inode: 42}
	if executableReplaced(base, base) {
		t.Fatal("an unchanged file must not trigger a relaunch")
	}
	for _, changed := range []fileStamp{
		{Size: 101, Mod: base.Mod, Inode: base.Inode},
		{Size: base.Size, Mod: base.Mod.Add(time.Second), Inode: base.Inode},
		{Size: base.Size, Mod: base.Mod, Inode: 43},
	} {
		if !executableReplaced(base, changed) {
			t.Fatalf("a replaced binary must trigger a relaunch: %+v", changed)
		}
	}
}

func TestRecordRelaunchWritesWhereItCanBeRead(t *testing.T) {
	dir := t.TempDir()
	s := &shell{paths: Paths{StateDir: dir}}
	before := fileStamp{Size: 10, Mod: time.Unix(1_700_000_000, 0), Inode: 7}
	after := fileStamp{Size: 11, Mod: time.Unix(1_700_000_100, 0), Inode: 8}
	s.recordRelaunch("/Applications/Graph.app/Contents/MacOS/Graph", before, after)
	payload, err := os.ReadFile(filepath.Join(dir, "app-relaunch.log"))
	if err != nil {
		t.Fatalf("the relaunch must leave a record: %v", err)
	}
	text := string(payload)
	for _, want := range []string{"/Applications/Graph.app/Contents/MacOS/Graph", "size=10", "size=11", "inode=7"} {
		if !strings.Contains(text, want) {
			t.Fatalf("the record is missing %q: %s", want, text)
		}
	}
}
