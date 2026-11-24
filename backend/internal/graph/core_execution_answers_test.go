// graph:table-writes-exempt: the test seeds the rows an admission reads
package graph

import (
	"path/filepath"
	"strings"
	"testing"
)

func answersFixture(t *testing.T) (*TaskStore, *Execution, ExecutionNodeRow, NodeSpec) {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "answers.sqlite"))
	t.Cleanup(store.Close)
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/answers-fixture','[]')`,
		`INSERT INTO tasks(id,project_id,conversation_id,request,requirement_version,latest_proposal,created_seq,phase) VALUES('t1','p1','c1','say hello',1,0,1,'chatting')`,
		`INSERT INTO conversations(id,workspace_project_id,anchor_task_id,title,created_seq,created_at,role) VALUES('c1','p1','t1','Main',1,0,'global')`,
		`INSERT INTO nodes(task_id,id,spec,status,activation_id,instance_id) VALUES('t1','master','{"role":"master","kind":"agent"}','pending','a1','i1')`,
		`INSERT INTO instances(id,task_id,node_id,model) VALUES('i1','t1','master','m1')`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	execution := &Execution{store: store, lifecycle: NewOperationLifecycle(store, OperationLifecycleHooks{})}
	master := "master"
	agent := "agent"
	instance := "i1"
	return store, execution, ExecutionNodeRow{Id: "master", TaskId: "t1", InstanceId: &instance, ActivationId: "a1"},
		NodeSpec{Id: "master", Kind: agent, Role: &master}
}

func answeredQuestion(t *testing.T, store *TaskStore, id, answer, requestType string) {
	t.Helper()
	data := map[string]any{"prompt": "pick one", "requestType": requestType}
	if _, err := store.DB.Exec(`INSERT INTO questions(id,task_id,node_id,kind,data,status,answer,owner,asked_at)
    VALUES(?,'t1','master','waiting',?,'resolved',?,'user',?)`,
		id, CanonicalJSON(data), CanonicalJSON(map[string]any{"type": "respond", "value": answer}), NowMillis()); err != nil {
		t.Fatalf("seed question: %v", err)
	}
}

func briefingOf(operation Operation) string {
	if operation.Context.Briefing == nil {
		return ""
	}
	return *operation.Context.Briefing
}

func admitOnce(t *testing.T, execution *Execution, node ExecutionNodeRow, spec NodeSpec) Operation {
	t.Helper()
	operation, admitted := execution.admit(node, spec, 0, nil, nil)
	if !admitted {
		t.Fatal("the node was not admitted")
	}
	return operation
}

func TestAnAnsweredQuestionReachesOnlyOneTurn(t *testing.T) {
	store, execution, node, spec := answersFixture(t)
	answeredQuestion(t, store, "q-old", "no one else is writing it", "user_decision")

	first := admitOnce(t, execution, node, spec)
	if len(first.Context.Answers) != 1 {
		t.Fatalf("the answered question must reach the next turn, answers %+v", first.Context.Answers)
	}
	if briefing := briefingOf(first); !strings.Contains(briefing, "Answers:") {
		t.Fatalf("the next turn must carry the answer in its briefing: %s", briefing)
	}

	second := admitOnce(t, execution, node, spec)
	if len(second.Context.Answers) != 0 {
		t.Fatalf("an answer already delivered must not be delivered again, answers %+v", second.Context.Answers)
	}
	if briefing := briefingOf(second); strings.Contains(briefing, "Answers:") {
		t.Fatalf("the briefing of a later turn still replays the answer: %s", briefing)
	}

	third := admitOnce(t, execution, node, spec)
	if len(third.Context.Answers) != 0 {
		t.Fatalf("an answer must never come back, answers %+v", third.Context.Answers)
	}
}

func TestACancelledTurnDoesNotConsumeTheAnswer(t *testing.T) {
	store, execution, node, spec := answersFixture(t)
	answeredQuestion(t, store, "q-kept", "yes, do it", "user_decision")

	first := admitOnce(t, execution, node, spec)
	if len(first.Context.Answers) != 1 {
		t.Fatalf("the first turn must carry the answer, answers %+v", first.Context.Answers)
	}
	execution.lifecycle.CancelBeforeDispatch(first.Id, "cancelled before send")

	second := admitOnce(t, execution, node, spec)
	if len(second.Context.Answers) != 1 {
		t.Fatalf("a turn cancelled before it ran must not consume the answer, answers %+v", second.Context.Answers)
	}
}

func TestANewContextDropsTheAnswerItNeverSaw(t *testing.T) {
	store, execution, node, spec := answersFixture(t)
	answeredQuestion(t, store, "q-unseen", "we picked the slower path", "user_decision")

	// /new: the model context and the pending answers both start over.
	(&TaskRuntime{store: store}).Conversations().NewContext("c1", "req-new-context")

	first := admitOnce(t, execution, node, spec)
	if len(first.Context.Answers) != 0 {
		t.Fatalf("an answer the reset turn never saw must not surface afterwards, answers %+v", first.Context.Answers)
	}
	if briefing := briefingOf(first); strings.Contains(briefing, "Answers:") {
		t.Fatalf("the briefing after /new still carries an old answer: %s", briefing)
	}

	// An answer given after the reset still reaches exactly one turn.
	answeredQuestion(t, store, "q-fresh", "after the reset", "user_decision")
	second := admitOnce(t, execution, node, spec)
	if len(second.Context.Answers) != 1 {
		t.Fatalf("an answer given after the reset must reach the next turn, answers %+v", second.Context.Answers)
	}
	third := admitOnce(t, execution, node, spec)
	if len(third.Context.Answers) != 0 {
		t.Fatalf("the fresh answer must reach only one turn, answers %+v", third.Context.Answers)
	}
}

func TestRetryingAFailedTurnBringsItsAnswerBack(t *testing.T) {
	store, execution, node, spec := answersFixture(t)
	answeredQuestion(t, store, "q-retried", "run it against main", "user_decision")

	first := admitOnce(t, execution, node, spec)
	if len(first.Context.Answers) != 1 {
		t.Fatalf("the failed turn must have consumed the answer, answers %+v", first.Context.Answers)
	}
	kernelExec(store.DB, `INSERT INTO questions(id,task_id,node_id,operation_id,kind,data,status,owner,asked_at)
    VALUES('q-failed','t1','master',?,'execution_failed','{"reason":"provider error"}','open','main',?)`,
		first.Id, NowMillis())

	execution.lifecycle.Answer("t1", "q-failed", Answer{Type: "retry"}, nil)

	second := admitOnce(t, execution, node, spec)
	if len(second.Context.Answers) != 1 {
		t.Fatalf("a retried turn must carry the answer it never acted on, answers %+v", second.Context.Answers)
	}
	third := admitOnce(t, execution, node, spec)
	if len(third.Context.Answers) != 0 {
		t.Fatalf("the answer still reaches only one turn after the retry, answers %+v", third.Context.Answers)
	}
}

func TestTheMigrationCountsARecordedAnswerAsDeliveredAndKeepsAnUnrecordedOne(t *testing.T) {
	path := filepath.Join(t.TempDir(), "migration.sqlite")
	store := openTaskStore(t, path)
	for _, statement := range []string{
		`INSERT INTO projects(id,root,grants) VALUES('p1','/tmp/migration-fixture','[]')`,
		`INSERT INTO tasks(id,project_id,request,created_seq,phase) VALUES('t1','p1','goal',1,'chatting')`,
		`INSERT INTO nodes(task_id,id,spec,status) VALUES('t1','master','{"role":"master"}','pending')`,
		`INSERT INTO questions(id,task_id,node_id,kind,data,status,answer,owner,asked_at) VALUES('q-delivered','t1','master','waiting','{}','resolved','{"type":"respond","value":"yes"}','user',1)`,
		`INSERT INTO questions(id,task_id,node_id,kind,data,status,answer,owner,asked_at) VALUES('q-pending','t1','master','waiting','{}','resolved','{"type":"respond","value":"later"}','user',2)`,
		`INSERT INTO operations(id,task_id,node_id,generation,spec,state,reserved) VALUES('op-old','t1','master',1,'{"context":{"answers":[{"questionId":"q-delivered"}]}}','succeeded',0)`,
	} {
		if _, err := store.DB.Exec(statement); err != nil {
			t.Fatalf("seed: %v", err)
		}
	}
	// Rewind to the state a database predating the delivery marker was in.
	kernelExec(store.DB, "UPDATE questions SET answers_delivered_by=NULL,answers_delivered_at=NULL")
	kernelExec(store.DB, "PRAGMA user_version=65")
	store.Close()

	reopened := openTaskStore(t, path)
	defer reopened.Close()
	delivered := kernelRows(reopened.Db, `SELECT id FROM questions WHERE answers_delivered_by='migration'`)
	if len(delivered) != 1 || kernelString(delivered[0]["id"]) != "q-delivered" {
		t.Fatalf("only the answer a turn already carried counts as delivered, got %+v", delivered)
	}
	pending := kernelRows(reopened.Db, `SELECT id FROM questions WHERE answers_delivered_by IS NULL`)
	if len(pending) != 1 || kernelString(pending[0]["id"]) != "q-pending" {
		t.Fatalf("an answer no turn ever carried keeps its one delivery, got %+v", pending)
	}
}
