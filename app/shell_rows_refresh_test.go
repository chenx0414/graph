package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
)

type rowsServer struct {
	mutex  sync.Mutex
	rows   string
	rev    int
	reads  int
	server *httptest.Server
}

func newRowsServer(t *testing.T) *rowsServer {
	t.Helper()
	rows := &rowsServer{rows: `[{"id":"c1","title":"13-Graph","projectId":"13-Graph","role":"project"}]`, rev: 1}
	rows.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		rows.mutex.Lock()
		defer rows.mutex.Unlock()
		if r.URL.Path == "/api/conversations/version" {
			_, _ = w.Write([]byte(fmt.Sprintf(`{"version":"r%d"}`, rows.rev)))
			return
		}
		rows.reads++
		_, _ = w.Write([]byte(rows.rows))
	}))
	t.Cleanup(rows.server.Close)
	return rows
}

func (rows *rowsServer) add(row string) {
	rows.mutex.Lock()
	defer rows.mutex.Unlock()
	rows.rows = rows.rows[:len(rows.rows)-1] + `,` + row + `]`
	rows.rev++
}

func (rows *rowsServer) readsSoFar() int {
	rows.mutex.Lock()
	defer rows.mutex.Unlock()
	return rows.reads
}

func TestTheSidebarPicksUpAConversationCreatedElsewhere(t *testing.T) {
	rows := newRowsServer(t)
	state := newShellState(rows.server.URL, "tok")
	if !state.refresh() {
		t.Fatal("the first read has to load the sidebar")
	}
	if len(state.conversations) != 1 {
		t.Fatalf("expected one project conversation, got %d", len(state.conversations))
	}
	rows.add(`{"id":"c2","title":"19-xhs-mini-tools","projectId":"19-xhs-mini-tools","role":"project"}`)
	if !state.refresh() {
		t.Fatal("a conversation created by someone else has to show up without a click or a restart")
	}
	if len(state.conversations) != 2 {
		t.Fatalf("the new project conversation is missing, rows %d", len(state.conversations))
	}
}

func TestTheSidebarDoesNotReReadAnUnchangedList(t *testing.T) {
	rows := newRowsServer(t)
	state := newShellState(rows.server.URL, "tok")
	if !state.refresh() {
		t.Fatal("the first read has to load the sidebar")
	}
	reads := rows.readsSoFar()
	for tick := 0; tick < 3; tick++ {
		if state.refresh() {
			t.Fatal("an unchanged list must not report a change on every poll")
		}
	}
	if rows.readsSoFar() != reads {
		t.Fatalf("the shell re-read the whole list %d times for nothing", rows.readsSoFar()-reads)
	}
}
