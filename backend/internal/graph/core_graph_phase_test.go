// graph:table-writes-exempt: the phase fixture seeds the project and task rows the lifecycle guards read
package graph

import (
	"path/filepath"
	"testing"
)

func phaseStore(t *testing.T, phase string) (*TaskStore, *KernelStore) {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "phase.sqlite"))
	t.Cleanup(store.Close)
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := store.DB.Exec(query, args...); err != nil {
			t.Fatalf("exec %q: %v", query, err)
		}
	}
	exec(`INSERT INTO projects(id,root,grants) VALUES('p','/tmp/p','[]')`)
	exec(`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version)
		VALUES('t','p','',1,0,?,0,1,1)`, phase)
	exec(`INSERT INTO nodes(task_id,id,spec,status) VALUES('t','n','{}','idle')`)
	kernel := NewKernelStore(store)
	exec(`INSERT INTO kernel_nodes(task_id,revision_version,node_id,instance_id,kind,spec,status)
		VALUES('t',1,'n','i','agent','{}','idle')`)
	return store, kernel
}

func phaseOf(t *testing.T, store *TaskStore) string {
	t.Helper()
	return store.Task("t").Phase
}

func raisedCode(t *testing.T, call func()) (code string) {
	t.Helper()
	defer func() {
		recovered := recover()
		if recovered == nil {
			return
		}
		failure, ok := recovered.(*RuntimeError)
		if !ok {
			t.Fatalf("the guard raised %T, want a runtime error", recovered)
		}
		code = failure.Code
	}()
	call()
	return ""
}

func TestClosedPhaseRefusesBudgetAndPause(t *testing.T) {
	for _, phase := range []string{"completed", "stopping", "stopped", "abandoned"} {
		store, kernel := phaseStore(t, phase)
		if code := raisedCode(t, func() { kernel.SetAuthorizedBudget("t", "n", nil) }); code != "invalid_graph" {
			t.Fatalf("phase %q accepts a budget change, code %q", phase, code)
		}
		kernel.SetNativePause("t", true, "", NowMillis())
		if row := kernelRow(store.Db, "SELECT graph_paused FROM kernel_nodes WHERE task_id='t'"); row == nil || kernelInt(row["graph_paused"]) != 0 {
			t.Fatalf("phase %q accepts a pause, row %+v", phase, row)
		}
	}
}

func TestOpenPhaseAcceptsBudgetAndPause(t *testing.T) {
	for _, phase := range []string{"discussing", "chatting", "queued", "running", "idle", "blocked", "completing"} {
		store, kernel := phaseStore(t, phase)
		if code := raisedCode(t, func() { kernel.SetAuthorizedBudget("t", "n", nil) }); code == "invalid_graph" {
			t.Fatalf("phase %q is treated as closed for budget", phase)
		}
		kernel.SetNativePause("t", true, "", NowMillis())
		if row := kernelRow(store.Db, "SELECT graph_paused FROM kernel_nodes WHERE task_id='t'"); row == nil || kernelInt(row["graph_paused"]) != 1 {
			t.Fatalf("phase %q does not accept a pause, row %+v", phase, row)
		}
	}
}

func TestPhaseWriteGuardsKeepClosedPhases(t *testing.T) {
	for _, phase := range []string{"completed", "stopping", "stopped"} {
		store, _ := phaseStore(t, phase)
		store.BlockTaskPhase("t")
		if got := phaseOf(t, store); got != phase {
			t.Fatalf("blocking a %q graph moved it to %q", phase, got)
		}
		store.CompleteTaskPhase("t")
		if got := phaseOf(t, store); got != phase {
			t.Fatalf("completing a %q graph moved it to %q", phase, got)
		}
		store.CompleteBlockedTask("t")
		if got := phaseOf(t, store); got != phase {
			t.Fatalf("closing a %q graph moved it to %q", phase, got)
		}
	}
}

func TestPhaseWriteGuardsMoveOpenPhases(t *testing.T) {
	store, _ := phaseStore(t, "running")
	store.BlockTaskPhase("t")
	if got := phaseOf(t, store); got != "blocked" {
		t.Fatalf("blocking a running graph reads %q", got)
	}
	store, _ = phaseStore(t, "running")
	store.CompleteTaskPhase("t")
	if got := phaseOf(t, store); got != "completing" {
		t.Fatalf("completing a running graph reads %q", got)
	}
	store, _ = phaseStore(t, "blocked")
	store.CompleteBlockedTask("t")
	if got := phaseOf(t, store); got != "blocked" {
		t.Fatalf("closing a blocked graph without a completion request reads %q", got)
	}
	store, _ = phaseStore(t, "blocked")
	if _, err := store.DB.Exec("INSERT INTO kernel_lifecycle(task_id,completion_requested) VALUES('t',1)"); err != nil {
		t.Fatalf("request completion: %v", err)
	}
	store.CompleteBlockedTask("t")
	if got := phaseOf(t, store); got != "completing" {
		t.Fatalf("closing a blocked graph with a completion request reads %q", got)
	}
}

func TestGraphPhasePredicatesPinTheLifecycleVocabulary(t *testing.T) {
	cases := []struct {
		phase        GraphPhase
		closed       bool
		cancelling   bool
		completion   bool
		laneEligible bool
	}{
		{PhaseDiscussing, false, false, false, false},
		{PhaseChatting, false, false, false, false},
		{PhaseQueued, false, false, false, false},
		{PhaseRunning, false, false, false, true},
		{PhaseIdle, false, false, false, true},
		{PhasePaused, false, false, false, false},
		{PhaseBlocked, false, false, false, true},
		{PhaseCompleting, false, false, true, true},
		{PhaseCompleted, true, false, true, false},
		{PhaseStopping, true, true, false, true},
		{PhaseStopped, true, true, false, false},
		{PhaseAbandoned, true, false, false, false},
	}
	for _, want := range cases {
		if got := want.phase.Closed(); got != want.closed {
			t.Errorf("%q closed is %v, want %v", want.phase, got, want.closed)
		}
		if got := want.phase.Cancelling(); got != want.cancelling {
			t.Errorf("%q cancelling is %v, want %v", want.phase, got, want.cancelling)
		}
		if got := want.phase.CompletionClosed(); got != want.completion {
			t.Errorf("%q completion-closed is %v, want %v", want.phase, got, want.completion)
		}
		if got := want.phase.LaneEligible(); got != want.laneEligible {
			t.Errorf("%q lane-eligible is %v, want %v", want.phase, got, want.laneEligible)
		}
	}
}

func TestDisplayPhaseOnlyPausesOpenPhases(t *testing.T) {
	for _, phase := range []GraphPhase{PhaseDiscussing, PhaseChatting, PhaseQueued, PhaseRunning, PhaseIdle, PhaseBlocked, PhaseCompleting} {
		if got := displayPhase(string(phase), true); got != PhasePaused {
			t.Fatalf("a paused %q graph displays %q", phase, got)
		}
		if got := displayPhase(string(phase), false); got != phase {
			t.Fatalf("an unpaused %q graph displays %q", phase, got)
		}
	}
	for _, phase := range []GraphPhase{PhaseCompleted, PhaseStopping, PhaseStopped, PhaseAbandoned} {
		if got := displayPhase(string(phase), true); got != phase {
			t.Fatalf("a paused %q graph displays %q", phase, got)
		}
	}
}

func TestEveryStoredTaskPhaseIsInTheVocabulary(t *testing.T) {
	for _, phase := range []GraphPhase{PhaseDiscussing, PhaseChatting, PhaseQueued, PhaseRunning, PhaseIdle, PhasePaused, PhaseBlocked, PhaseCompleting, PhaseCompleted, PhaseStopping, PhaseStopped, PhaseAbandoned} {
		if !phase.Known() {
			t.Fatalf("%q is missing from the phase vocabulary", phase)
		}
	}
	if GraphPhase("invented").Known() {
		t.Fatal("an unregistered phase string counts as known")
	}
}
