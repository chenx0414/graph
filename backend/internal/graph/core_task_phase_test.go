// graph:table-writes-exempt: a test seeds the rows its subject reads
package graph

import (
	"path/filepath"
	"testing"
)

func lifecycleStore(t *testing.T, phases ...string) *TaskStore {
	t.Helper()
	store := openTaskStore(t, filepath.Join(t.TempDir(), "lifecycle.sqlite"))
	t.Cleanup(store.Close)
	if _, err := store.DB.Exec(`INSERT INTO projects(id,root,grants) VALUES('p','/tmp/lifecycle','[]')`); err != nil {
		t.Fatalf("seed project: %v", err)
	}
	for index, phase := range phases {
		id := "t" + string(rune('a'+index))
		if _, err := store.DB.Exec(`INSERT INTO tasks(id,project_id,request,requirement_version,latest_proposal,phase,paused,created_seq,graph_version)
			VALUES(?, 'p', '', 1, 0, ?, 0, ?, 1)`, id, phase, index+1); err != nil {
			t.Fatalf("seed task %q: %v", phase, err)
		}
	}
	return store
}

func lifecyclePhase(t *testing.T, store *TaskStore, id string) string {
	t.Helper()
	var phase string
	if err := store.DB.QueryRow("SELECT phase FROM tasks WHERE id=?", id).Scan(&phase); err != nil {
		t.Fatalf("read phase of %q: %v", id, err)
	}
	return phase
}

func lifecyclePaused(t *testing.T, store *TaskStore, id string) int64 {
	t.Helper()
	var paused int64
	if err := store.DB.QueryRow("SELECT paused FROM tasks WHERE id=?", id).Scan(&paused); err != nil {
		t.Fatalf("read paused of %q: %v", id, err)
	}
	return paused
}

func TestTaskPhaseFamiliesAreDisjointAndComplete(t *testing.T) {
	for _, phase := range []GraphPhase{
		PhaseDiscussing, PhaseChatting, PhaseQueued, PhaseRunning, PhaseIdle,
		PhaseBlocked, PhaseCompleting, PhaseCompleted, PhaseStopping, PhaseStopped,
		PhaseAbandoned,
	} {
		members := 0
		if taskPhaseConversational(phase) {
			members++
		}
		if taskPhaseWorking(phase) {
			members++
		}
		if taskPhaseHalting(phase) {
			members++
		}
		if members != 1 {
			t.Fatalf("%q belongs to %d families; a stored phase belongs to exactly one", phase, members)
		}
	}
	if taskPhaseHalting(PhasePaused) || taskPhaseConversational(PhasePaused) || taskPhaseWorking(PhasePaused) {
		t.Fatal("paused is a presented overlay, never a stored task phase")
	}
}

func TestHaltingCoversStoppingAndEveryFinishedPhase(t *testing.T) {
	for _, phase := range []GraphPhase{PhaseStopping, PhaseCompleted, PhaseStopped, PhaseAbandoned} {
		if !taskPhaseHalting(phase) {
			t.Fatalf("%q must halt work", phase)
		}
	}
	for _, phase := range []GraphPhase{PhaseQueued, PhaseRunning, PhaseIdle, PhaseBlocked, PhaseCompleting} {
		if taskPhaseHalting(phase) {
			t.Fatalf("%q must still accept work", phase)
		}
	}
	for _, phase := range []GraphPhase{PhaseCompleted, PhaseStopped, PhaseAbandoned} {
		if !taskPhaseFinished(phase) {
			t.Fatalf("%q is finished", phase)
		}
	}
	if taskPhaseFinished(PhaseStopping) {
		t.Fatal("stopping is still settling; it halts but is not finished")
	}
}

func TestTerminalWorkcopyPhasesIncludeEveryFinishedPhase(t *testing.T) {
	got := map[GraphPhase]bool{}
	for _, phase := range terminalWorkcopyPhases() {
		got[phase] = true
	}
	for _, phase := range []GraphPhase{PhaseCompleted, PhaseStopped, PhaseAbandoned} {
		if !got[phase] {
			t.Fatalf("workcopies of a %q task are never swept", phase)
		}
	}
	if got[PhaseRunning] || got[PhaseBlocked] || got[PhaseStopping] {
		t.Fatalf("a live or still-stopping task must keep its workcopies: %v", got)
	}
}

func TestBlockingAFinishedTaskKeepsItsPhase(t *testing.T) {
	for _, phase := range []GraphPhase{PhaseCompleted, PhaseStopped, PhaseAbandoned} {
		store := lifecycleStore(t, string(phase))
		store.BlockTaskPhase("ta")
		store.CompleteTaskPhase("ta")
		store.BlockTask("ta")
		if got := lifecyclePhase(t, store, "ta"); got != string(phase) {
			t.Fatalf("writing a finished %q task moved it to %q", phase, got)
		}
	}
	store := lifecycleStore(t, string(PhaseRunning))
	store.BlockTaskPhase("ta")
	if got := lifecyclePhase(t, store, "ta"); got != string(PhaseBlocked) {
		t.Fatalf("blocking a running task reads %q", got)
	}
	store = lifecycleStore(t, string(PhaseAbandoned))
	store.ResumeTask("ta")
	if got := lifecyclePhase(t, store, "ta"); got != string(PhaseAbandoned) {
		t.Fatalf("resuming an abandoned task reads %q", got)
	}
	store = lifecycleStore(t, string(PhaseRunning))
	store.StopTask("ta")
	if got := lifecyclePhase(t, store, "ta"); got != string(PhaseStopping) {
		t.Fatalf("stopping a running task reads %q", got)
	}
	store = lifecycleStore(t, string(PhaseStopping))
	store.StopTask("ta")
	if got := lifecyclePhase(t, store, "ta"); got != string(PhaseStopping) {
		t.Fatalf("stopping a stopping task reads %q", got)
	}
}

func TestAbandoningACompletedTaskKeepsItsPhase(t *testing.T) {
	for _, phase := range []GraphPhase{PhaseCompleted, PhaseStopped} {
		store := lifecycleStore(t, string(phase))
		store.AbandonTask("ta")
		if got := lifecyclePhase(t, store, "ta"); got != string(phase) {
			t.Fatalf("abandoning a %q task moved it to %q", phase, got)
		}
	}
	store := lifecycleStore(t, string(PhaseRunning))
	store.AbandonTask("ta")
	if got := lifecyclePhase(t, store, "ta"); got != string(PhaseAbandoned) {
		t.Fatalf("abandoning a running task reads %q", got)
	}
}

func TestPauseProjectTasksSkipsConversationsAndHaltingWork(t *testing.T) {
	phases := []GraphPhase{
		PhaseChatting, PhaseDiscussing, PhaseQueued, PhaseRunning, PhaseIdle,
		PhaseBlocked, PhaseCompleting, PhaseStopping, PhaseCompleted, PhaseStopped,
		PhaseAbandoned,
	}
	values := make([]string, len(phases))
	for index, phase := range phases {
		values[index] = string(phase)
	}
	store := lifecycleStore(t, values...)
	store.PauseProjectTasks("p")
	for index, phase := range phases {
		id := "t" + string(rune('a'+index))
		paused := lifecyclePaused(t, store, id)
		want := int64(0)
		if taskPhasePausedOnArchive(phase) {
			want = 1
		}
		if paused != want {
			t.Fatalf("%q task paused = %d, want %d", phase, paused, want)
		}
	}
	if taskPhasePausedOnArchive(PhaseChatting) {
		t.Fatal("a chat is the control conversation and is never paused")
	}
	if !taskPhasePausedOnArchive(PhaseDiscussing) {
		t.Fatal("a requirement discussion is work and is paused")
	}
}

func TestArchivablePhasesMatchThePredicate(t *testing.T) {
	got := map[GraphPhase]bool{}
	for _, phase := range taskPhaseArchivableList() {
		got[phase] = true
	}
	for _, phase := range []GraphPhase{
		PhaseDiscussing, PhaseChatting, PhaseQueued, PhaseRunning, PhaseIdle,
		PhaseBlocked, PhaseCompleting, PhaseStopping, PhaseCompleted, PhaseStopped,
		PhaseAbandoned,
	} {
		if got[phase] != taskPhaseArchivable(phase) {
			t.Fatalf("%q appears in the list=%v but the predicate says %v", phase, got[phase], taskPhaseArchivable(phase))
		}
	}
	if taskPhaseArchivable(PhaseBlocked) {
		t.Fatal("a blocked graph is waiting on the operator and stays unarchived")
	}
	if taskPhaseArchivable(PhaseAbandoned) {
		t.Fatal("an abandoned graph is finished")
	}
}

func TestConversationTasksRefuseAPhaseOutsideTheVocabulary(t *testing.T) {
	store := lifecycleStore(t)
	defer func() {
		if recovered := recover(); recovered == nil {
			t.Fatal("a conversation task must not be created with an invented phase")
		}
	}()
	store.CreateConversationTask("t-new", "p", "hello", "invented", 1, "c1")
}
