// graph:table-writes-exempt: a test seeds the rows it reopens around
package graph

import (
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

func TestFleetSignatureFollowsTheEventsItDependsOn(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "tasks.sqlite"))
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/graph-fleet-cache','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('task','p','r',1,0,1,'chatting')")
	before := fleetSignature(store, "")
	store.Event("task", "fleet.cache.probe", map[string]any{"ok": true})
	after := fleetSignature(store, "")
	if before == after {
		t.Fatalf("a new event invalidates the cached fleet snapshot, before %q after %q", before, after)
	}
}

func fleetCacheProbe(t *testing.T, request string) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "fleet.sqlite"))
	if _, err := store.Db.Exec(`INSERT INTO projects(id,root,grants) VALUES('global-workspace','/tmp/global','[]')`); err != nil {
		t.Fatalf("seed the probe project: %v", err)
	}
	if _, err := store.Db.Exec(`INSERT INTO tasks(id,project_id,request,created_seq,phase,conversation_id)
		VALUES('t','global-workspace',?,1,'chatting','c')`, request); err != nil {
		t.Fatalf("seed the probe task: %v", err)
	}
	return store
}

func fleetCacheEntries(store *TaskStore) int {
	prefix := fmt.Sprintf("%p|", store)
	fleetSnapshots.Lock()
	defer fleetSnapshots.Unlock()
	count := 0
	for key := range fleetSnapshots.values {
		if strings.HasPrefix(key, prefix) {
			count++
		}
	}
	return count
}

func TestFleetSnapshotCacheForgetsAClosedStore(t *testing.T) {
	store := fleetCacheProbe(t, "first request")
	if body := fleetPayloadCached(store, ""); len(body) == 0 {
		t.Fatal("the probe store produced no payload, so nothing was cached to forget")
	}
	if entries := fleetCacheEntries(store); entries != 1 {
		t.Fatalf("expected the payload under one key, got %d", entries)
	}
	store.Close()
	if entries := fleetCacheEntries(store); entries != 0 {
		t.Fatalf("%d cached payloads outlived their store; a later store that the allocator places at the same address would be answered with them", entries)
	}
}
