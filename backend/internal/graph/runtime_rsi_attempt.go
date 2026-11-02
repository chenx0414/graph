package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

// An attempt whose call never came back.
//
// Measured 2026-11-02: apply_rsi_change was interrupted while its gate was
// running and answered only "may have partially run". The commit had in fact
// landed, the gate had passed and the reload was confirmed later - and the only
// way to learn that was to read Git by hand, while the gate ran a second time.
//
// A tool that writes history has to be able to answer, after the fact, what it
// did. The attempt is therefore written before anything is written, and cleared
// when the call finishes; the one that survives is the one that was interrupted.

// RsiAttemptRecord is the attempt as it was persisted before it started working.
type RsiAttemptRecord struct {
	Id        string   `json:"id"`
	Title     string   `json:"title"`
	Root      string   `json:"root"`
	Branch    string   `json:"branch"`
	BaseHead  string   `json:"baseHead"`
	Paths     []string `json:"paths"`
	StartedAt int64    `json:"startedAt"`
}

// RsiInterruptedAttempt is what the status reports about it: whether a commit
// with its subject landed on the branch, and what the checkout is on now.
type RsiInterruptedAttempt struct {
	Id        string   `json:"id"`
	Title     string   `json:"title"`
	BaseHead  string   `json:"baseHead"`
	Paths     []string `json:"paths"`
	StartedAt int64    `json:"startedAt"`
	Committed bool     `json:"committed"`
	Commit    *string  `json:"commit"`
	Head      *string  `json:"head"`
}

// rsiAttemptPath is where the attempt in flight lives.
func (service *RsiService) rsiAttemptPath() string {
	return filepath.Join(service.stateDir, "rsi", "attempt.json")
}

// rsiWriteAttempt records an attempt before it touches anything, so an
// interrupted call can still be answered afterwards.
func (service *RsiService) rsiWriteAttempt(record RsiAttemptRecord) error {
	encoded, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return rsiWriteAtomic(service.rsiAttemptPath(), string(encoded)+"\n")
}

// rsiBeginAttempt records the call in flight; rsiClearAttempt ends the record.
func (service *RsiService) rsiBeginAttempt(id, title, root, branch, baseHead string, paths []string) {
	_ = service.rsiWriteAttempt(RsiAttemptRecord{
		Id: id, Title: title, Root: root, Branch: branch,
		BaseHead: baseHead, Paths: paths, StartedAt: NowMillis(),
	})
}

// rsiClearAttempt says the call finished; whatever it did is in its receipt now.
func (service *RsiService) rsiClearAttempt() {
	_ = os.Remove(service.rsiAttemptPath())
}

// rsiReadAttempt reads the attempt a call left behind, or nothing when the last
// call finished.
func (service *RsiService) rsiReadAttempt() *RsiAttemptRecord {
	raw, err := os.ReadFile(service.rsiAttemptPath())
	if err != nil {
		return nil
	}
	record := RsiAttemptRecord{}
	if err := json.Unmarshal(raw, &record); err != nil || record.Id == "" {
		return nil
	}
	return &record
}

// rsiDeriveAttempt answers what an interrupted attempt did, from the repository
// itself: a commit with its subject on the branch now, or nothing.
//
// Reading Git is the point. The interrupted call cannot report anything, so the
// answer has to come from the only record that cannot be interrupted: the
// history it may have written.
func (service *RsiService) rsiDeriveAttempt(record RsiAttemptRecord) *RsiInterruptedAttempt {
	view := &RsiInterruptedAttempt{
		Id: record.Id, Title: record.Title, BaseHead: record.BaseHead,
		Paths: record.Paths, StartedAt: record.StartedAt,
	}
	if service.Root == nil || strings.TrimSpace(record.Title) == "" {
		return view
	}
	view.Head = RevParse(*service.Root, "HEAD")
	from := strings.TrimSpace(record.BaseHead)
	if from == "" {
		return view
	}
	subject := "rsi: " + record.Title
	found := Git(*service.Root, []string{"log", "-F", "--grep=" + subject, "--format=%H", from + "..HEAD"}, nil, nil)
	for _, line := range strings.Split(found.Stdout, "\n") {
		sha := strings.TrimSpace(line)
		if sha == "" {
			continue
		}
		view.Committed, view.Commit = true, &sha
		break
	}
	return view
}
