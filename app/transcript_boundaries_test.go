package main

import (
	"sync"
	"testing"
)

func TestRunBoundariesAreSafeUnderConcurrentHistoryLoad(t *testing.T) {
	state := newChatState("http://127.0.0.1:1", "tok")
	var wait sync.WaitGroup
	wait.Add(2)
	go func() {
		defer wait.Done()
		for index := 0; index < 500; index++ {
			state.markRunBoundary("m" + string(rune('a'+index%26)))
		}
	}()
	go func() {
		defer wait.Done()
		for index := 0; index < 500; index++ {
			_ = groupRunsAt(nil, state.runBoundarySnapshot())
		}
	}()
	wait.Wait()
	if !state.runBoundarySnapshot()["ma"] {
		t.Fatal("a marked boundary stays marked")
	}
}
