package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
)

// A reload does not have to wait for somebody's long tool call.
//
// Measured 2026-11-03: activating a harness change waited for a project
// supervisor's in-flight turn, and the user asked why a reload should queue
// behind unrelated work at all. The answer is to stop that work on purpose:
// interrupt the live turns, pause the tasks, and let the next daemon put them
// back. Only the tasks this reload paused are resumed - a task a person paused
// stays paused, because that decision was not ours.
//
// The list travels in a file, not in memory: the daemon that resumes is a
// different process from the one that paused.

// RsiService fields used here are set by the daemon once the runtime exists.
type RsiReloadHooks struct {
	Pause  func(store *TaskStore, excludeTaskID string) []string
	Resume func(store *TaskStore, ids []string) []string
}

func (service *RsiService) rsiResumePath() string {
	return filepath.Join(service.stateDir, "rsi", "resume.json")
}

// rsiPauseForReload interrupts and pauses everything still running, then
// remembers what it paused. It returns the task ids, or nil when nothing ran.
func rsiPauseForReload(service *RsiService, store *TaskStore, excludeTaskID string) []string {
	if service == nil || store == nil || service.reload == nil || service.reload.Pause == nil {
		return nil
	}
	ids := service.reload.Pause(store, excludeTaskID)
	if len(ids) == 0 {
		return nil
	}
	encoded, err := json.Marshal(ids)
	if err != nil {
		return ids
	}
	_ = rsiWriteAtomic(service.rsiResumePath(), string(encoded)+"\n")
	return ids
}

// rsiConsumeResume continues exactly what the last reload paused. It runs once,
// after the new daemon is up; the file is removed whether or not every task
// could be resumed, so a stale list can never pause work for ever.
func rsiConsumeResume(service *RsiService, store *TaskStore, log func(string)) []string {
	if service == nil || store == nil || service.reload == nil || service.reload.Resume == nil {
		return nil
	}
	raw, err := os.ReadFile(service.rsiResumePath())
	if err != nil {
		return nil
	}
	ids := []string{}
	if err := json.Unmarshal(raw, &ids); err != nil {
		_ = os.Remove(service.rsiResumePath())
		return nil
	}
	resumed := service.reload.Resume(store, ids)
	_ = os.Remove(service.rsiResumePath())
	if log != nil {
		log("RSI resume: " + itoa(len(resumed)) + " task(s) continued after the reload")
	}
	return resumed
}
