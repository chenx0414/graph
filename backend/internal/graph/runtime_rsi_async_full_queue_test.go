// graph:table-writes-exempt: no table is written by this test
package graph

import (
	"sort"
	"testing"
	"time"
)

func rsiAsyncFullTestService(t *testing.T) *RsiService {
	t.Helper()
	root := t.TempDir()
	return &RsiService{Root: &root}
}

func TestAsyncFullDoesNotStartASecondRunWhileOneIsRunning(t *testing.T) {
	service := rsiAsyncFullTestService(t)
	started := make(chan string, 8)
	release := make(chan struct{})
	service.asyncFull.exec = func(store *TaskStore, job rsiAsyncFullJob) {
		started <- job.Commit
		<-release
	}
	service.rsiStartAsyncFull(nil, "a1", "commit-a", []string{"c1"})
	first := <-started
	if first != "commit-a" {
		t.Fatalf("the first run covered %s instead of commit-a", first)
	}
	service.rsiStartAsyncFull(nil, "a2", "commit-b", []string{"c1"})
	service.rsiStartAsyncFull(nil, "a3", "commit-c", []string{"c1"})
	release <- struct{}{}
	second := <-started
	if second != "commit-c" {
		t.Fatalf("the coalesced run covered %s instead of the newest commit-c", second)
	}
	release <- struct{}{}
	service.rsiWaitAsyncFullIdle(t)
	select {
	case extra := <-started:
		t.Fatalf("a third run started for %s; three activations produced three full runs", extra)
	default:
	}
}

func TestAsyncFullCoalescedRunKeepsEveryConversationThatWaited(t *testing.T) {
	service := rsiAsyncFullTestService(t)
	jobs := make(chan rsiAsyncFullJob, 4)
	release := make(chan struct{})
	service.asyncFull.exec = func(store *TaskStore, job rsiAsyncFullJob) {
		jobs <- job
		<-release
	}
	service.rsiStartAsyncFull(nil, "a1", "commit-a", []string{"c1"})
	<-jobs
	service.rsiStartAsyncFull(nil, "a2", "commit-b", []string{"c2"})
	service.rsiStartAsyncFull(nil, "a3", "commit-c", []string{"c3"})
	release <- struct{}{}
	second := <-jobs
	if second.Commit != "commit-c" {
		t.Fatalf("the coalesced run covered %s", second.Commit)
	}
	got := append([]string{}, second.Conversations...)
	sort.Strings(got)
	want := []string{"c2", "c3"}
	if len(got) != len(want) || got[0] != want[0] || got[1] != want[1] {
		t.Fatalf("the coalesced run reported to %v instead of every waiting conversation %v", got, want)
	}
	release <- struct{}{}
}

func TestAsyncFullReportsHowManyActivationsItMerged(t *testing.T) {
	service := rsiAsyncFullTestService(t)
	jobs := make(chan rsiAsyncFullJob, 4)
	release := make(chan struct{})
	service.asyncFull.exec = func(store *TaskStore, job rsiAsyncFullJob) {
		jobs <- job
		<-release
	}
	service.rsiStartAsyncFull(nil, "a1", "commit-a", []string{"c1"})
	first := <-jobs
	if first.Coalesced != 1 {
		t.Fatalf("an uncontended run claimed to merge %d activations", first.Coalesced)
	}
	service.rsiStartAsyncFull(nil, "a2", "commit-b", []string{"c1"})
	service.rsiStartAsyncFull(nil, "a3", "commit-c", []string{"c1"})
	release <- struct{}{}
	second := <-jobs
	if second.Coalesced != 2 {
		t.Fatalf("two queued activations were reported as %d merged", second.Coalesced)
	}
	release <- struct{}{}
}

func TestAsyncFullReportsTheSameOutcomeOnlyOnce(t *testing.T) {
	service := &RsiService{}
	if !service.rsiAsyncFullShouldReport("回归", []string{"tests/a.test.ts"}) {
		t.Fatalf("the first outcome was suppressed")
	}
	if service.rsiAsyncFullShouldReport("回归", []string{"tests/a.test.ts"}) {
		t.Fatalf("an unchanged outcome woke the agent a second time")
	}
	if !service.rsiAsyncFullShouldReport("环境故障", []string{"tests/a.test.ts"}) {
		t.Fatalf("a changed verdict was suppressed")
	}
	if !service.rsiAsyncFullShouldReport("环境故障", []string{"tests/a.test.ts", "tests/b.test.ts"}) {
		t.Fatalf("a changed failure set was suppressed")
	}
	if service.rsiAsyncFullShouldReport("环境故障", []string{"tests/b.test.ts", "tests/a.test.ts"}) {
		t.Fatalf("the same failure set in another order woke the agent again")
	}
}

func TestAsyncFullAPassingRunLetsTheSameFailureReportAgain(t *testing.T) {
	service := &RsiService{}
	service.rsiAsyncFullShouldReport("回归", []string{"tests/a.test.ts"})
	service.rsiAsyncFullNotePass()
	if !service.rsiAsyncFullShouldReport("回归", []string{"tests/a.test.ts"}) {
		t.Fatalf("a failure that came back after a green run stayed silent")
	}
}

func TestAsyncFullRunsAgainForACommitThatArrivesAfterTheDrain(t *testing.T) {
	service := rsiAsyncFullTestService(t)
	started := make(chan string, 8)
	release := make(chan struct{})
	service.asyncFull.exec = func(store *TaskStore, job rsiAsyncFullJob) {
		started <- job.Commit
		<-release
	}
	service.rsiStartAsyncFull(nil, "a1", "commit-a", []string{"c1"})
	<-started
	release <- struct{}{}
	service.rsiWaitAsyncFullIdle(t)
	service.rsiStartAsyncFull(nil, "a2", "commit-b", []string{"c1"})
	next := <-started
	if next != "commit-b" {
		t.Fatalf("a run that arrived after the queue drained covered %s", next)
	}
	release <- struct{}{}
}

func (service *RsiService) rsiWaitAsyncFullIdle(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		service.asyncFull.mu.Lock()
		running := service.asyncFull.running
		service.asyncFull.mu.Unlock()
		if !running {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("the full-run queue never drained")
}
