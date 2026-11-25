// graph:table-writes-exempt: the test seeds the interrupted turn a restart recovers
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

// dispatchMasterTurn seeds a master operation that was dispatched and then lost
// when the daemon stopped, with nothing in the conversation to say so.
func dispatchMasterTurn(t *testing.T, store *TaskStore, operationID string, dispatchedAt int64) {
	t.Helper()
	spec := `{"id":"` + operationID + `","taskId":"t1","nodeId":"master","instanceId":"i1","kind":"agent","action":"agent"}`
	if _, err := store.DB.Exec(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active,dispatched_at)
    VALUES(?,'t1','master','i1',1,?, 'dispatched',0,1,?)`, operationID, spec, dispatchedAt); err != nil {
		t.Fatalf("seed operation: %v", err)
	}
}

func lostTurnFixture(t *testing.T) (*TaskStore, *Execution) {
	t.Helper()
	store, execution, _, _ := answersFixture(t)
	NewKernelStore(store)
	return store, execution
}

func noticeTextsFor(store *TaskStore, operationID string) []string {
	texts := []string{}
	for _, row := range kernelRows(store.Db, "SELECT text FROM messages WHERE operation_id=? AND kind='notice' ORDER BY seq", operationID) {
		texts = append(texts, kernelString(row["text"]))
	}
	return texts
}

func TestATurnLostToARestartSaysSoInTheConversation(t *testing.T) {
	store, execution := lostTurnFixture(t)
	dispatchMasterTurn(t, store, "op-lost", NowMillis()-120000)

	execution.lifecycle.Recover()

	texts := noticeTextsFor(store, "op-lost")
	if len(texts) != 1 {
		t.Fatalf("a turn lost to a restart speaks exactly once in the conversation, got %v", texts)
	}
	if !strings.Contains(texts[0], "重载") && !strings.Contains(texts[0], "重启") {
		t.Fatalf("the notice names what interrupted the turn: %q", texts[0])
	}
	if !strings.Contains(texts[0], "再发一次") {
		t.Fatalf("the notice says what the user can do next: %q", texts[0])
	}

	// A second restart must not repeat itself.
	execution.lifecycle.Recover()
	if texts := noticeTextsFor(store, "op-lost"); len(texts) != 1 {
		t.Fatalf("the notice is not repeated on the next restart, got %v", texts)
	}
}

func TestALostTurnIsReportedOnceInsteadOfTwice(t *testing.T) {
	store, execution := lostTurnFixture(t)
	dispatchedAt := NowMillis() - 120000
	dispatchMasterTurn(t, store, "op-lost", dispatchedAt)

	execution.lifecycle.Recover()
	restartQuestions := kernelRows(store.Db, "SELECT id FROM questions WHERE kind='recovery' AND operation_id='op-lost'")
	if len(restartQuestions) != 1 {
		t.Fatalf("the restart reports the lost turn once, got %d", len(restartQuestions))
	}

	// An hour later the sweep looks at the same operation. It must recognise
	// the report the restart already raised, not raise a second one.
	runtime := &TaskRuntime{store: store}
	if raised := runtime.SweepUnsettledOperations(dispatchedAt + 2*SettledOperationCutoff); raised != 0 {
		t.Fatalf("the sweep raised %d more reports for a turn the restart already reported", raised)
	}
	total := kernelRows(store.Db, `SELECT id FROM questions WHERE kind='recovery'
    AND COALESCE(operation_id, json_extract(data,'$.operationId'))='op-lost'`)
	if len(total) != 1 {
		t.Fatalf("one lost turn is one problem, got %d", len(total))
	}
}

func TestAnUnreportedLostTurnStillSurfacesFromTheSweep(t *testing.T) {
	store, _ := lostTurnFixture(t)
	dispatchedAt := NowMillis() - 120000
	dispatchMasterTurn(t, store, "op-silent", dispatchedAt)
	kernelExec(store.DB, "UPDATE operations SET state='unknown',worker_active=0 WHERE id='op-silent'")

	runtime := &TaskRuntime{store: store}
	if raised := runtime.SweepUnsettledOperations(dispatchedAt + 2*SettledOperationCutoff); raised != 1 {
		t.Fatalf("an operation nobody has reported must surface once, raised %d", raised)
	}
}

func TestATaskWithoutAConversationGetsNoNotice(t *testing.T) {
	store := openTaskStore(t, filepath.Join(t.TempDir(), "no-conversation.sqlite"))
	defer store.Close()
	NewKernelStore(store)
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/no-conversation','[]')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('w1','p1','build it',1,'working')`,
		`INSERT INTO nodes(task_id,id,spec,status,activation_id,instance_id) VALUES('w1','n1','{"role":"worker","kind":"agent"}','pending','a1','i1')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i1','w1','n1','m1')`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	spec := `{"id":"op-worker","taskId":"w1","nodeId":"n1","instanceId":"i1","kind":"agent","action":"agent"}`
	if _, err := store.DB.Exec(`INSERT INTO operations(id,task_id,node_id,instance_id,generation,spec,state,reserved,worker_active,dispatched_at)
    VALUES('op-worker','w1','n1','i1',1,?, 'dispatched',0,1,?)`, spec, NowMillis()-120000); err != nil {
		t.Fatalf("seed operation: %v", err)
	}

	NewOperationLifecycle(store, OperationLifecycleHooks{}).Recover()

	if rows := kernelRows(store.Db, "SELECT id FROM messages WHERE operation_id='op-worker'"); len(rows) != 0 {
		t.Fatalf("a task with no conversation has nowhere to speak, wrote %d messages", len(rows))
	}
}
