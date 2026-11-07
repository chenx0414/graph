package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
)


type RsiReloadHooks struct {
	Pause  func(store *TaskStore, excludeTaskID string) []string
	Resume func(store *TaskStore, ids []string) []string
}

func (service *RsiService) rsiResumePath() string {
	return filepath.Join(service.stateDir, "rsi", "resume.json")
}

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
