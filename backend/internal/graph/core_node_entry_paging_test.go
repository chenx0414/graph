// graph:table-writes-exempt: the test seeds the entries the page reads
package graph

import (
	"path/filepath"
	"testing"
)

func seedNodeEntries(t *testing.T, count int) (*TaskStore, string, string) {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "node-entries.sqlite"))
	t.Cleanup(store.Close)
	NewKernelStore(store)
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/p1','[]')`); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t1','p1','node entries',1,'running')`); err != nil {
		t.Fatalf("seed task: %v", err)
	}
	for index := 0; index < count; index++ {
		AppendNodeEntry(store, NodeEntryInput{TaskID: "t1", NodeID: "work", Role: "tool", Kind: "call", Text: "call"})
	}
	return store, "t1", "work"
}

func TestNodeEntryPageSaysWhenOlderEntriesRunOut(t *testing.T) {
	store, taskID, nodeID := seedNodeEntries(t, 12)
	limit := float64(5)
	first := ListNodeEntries(store, taskID, nodeID, NodeEntryQuery{Limit: &limit})
	if len(first.Entries) != 5 || !first.HasOlder {
		t.Fatalf("first page = %d entries hasOlder %v", len(first.Entries), first.HasOlder)
	}
	before := float64(first.Entries[0].Seq)
	second := ListNodeEntries(store, taskID, nodeID, NodeEntryQuery{Limit: &limit, Before: &before})
	if len(second.Entries) != 5 || !second.HasOlder {
		t.Fatalf("second page = %d entries hasOlder %v", len(second.Entries), second.HasOlder)
	}
	before = float64(second.Entries[0].Seq)
	last := ListNodeEntries(store, taskID, nodeID, NodeEntryQuery{Limit: &limit, Before: &before})
	if len(last.Entries) != 2 {
		t.Fatalf("last page = %d entries", len(last.Entries))
	}
	if last.HasOlder {
		t.Fatal("the oldest page must report that no older entries remain")
	}
}
