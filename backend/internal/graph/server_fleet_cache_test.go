// graph:table-writes-exempt: a test seeds the rows it reopens around
package graph

import (
	"path/filepath"
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
