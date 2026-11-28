// graph:table-writes-exempt: a test seeds the task rows it then reads
package graph

import (
	"path/filepath"
	"testing"
)

func modelsInUseFixture(t *testing.T, phase, nodeStatus string) (*TaskStore, string) {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "models.sqlite"))
	NewKernelStore(store)
	kernelExec(store.DB, "INSERT INTO projects(id,root,grants) VALUES('p','/tmp/models-in-use-fixture','[]')")
	kernelExec(store.DB, "INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('t','p','c','r',1,0,1,?)", phase)
	kernelExec(store.DB, `INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role)
        VALUES('c','p','t','Main',1,0,'global')`)
	kernelExec(store.DB, "INSERT INTO nodes(task_id,id,spec,status,instance_id) VALUES('t','write','{\"model\":\"grok:grok-4.7\"}',?,'i')", nodeStatus)
	kernelExec(store.DB, "INSERT INTO instances(id,task_id,node_id,model) VALUES('i','t','write','grok:grok-4.7')")
	kernelExec(store.DB, `INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status)
        VALUES('t',1,'write','i','agent','{"model":"grok:grok-4.7"}',?)`, nodeStatus)
	return store, "grok:grok-4.7"
}

// A model is in use while work that will use it can still run. A task whose
// every node already succeeded will not run that model again, so holding it is
// what made "remove grok:grok-4.7" impossible with no run in flight.
func TestAModelIsNotInUseOnceEveryNodeThatBindsItSucceeded(t *testing.T) {
	store, model := modelsInUseFixture(t, "idle", "succeeded")
	runtime := &TaskRuntime{store: store, kernel: NewKernelStore(store)}
	for _, id := range runtime.ModelsInUse() {
		if id == model {
			t.Fatalf("%s is held by a node that already succeeded", model)
		}
	}
}

// A node that has not finished still holds its model.
func TestAModelIsInUseWhileANodeThatBindsItHasNotFinished(t *testing.T) {
	store, model := modelsInUseFixture(t, "idle", "running")
	runtime := &TaskRuntime{store: store, kernel: NewKernelStore(store)}
	found := false
	for _, id := range runtime.ModelsInUse() {
		if id == model {
			found = true
		}
	}
	if !found {
		t.Fatalf("a running node still holds %s, got %+v", model, runtime.ModelsInUse())
	}
}
