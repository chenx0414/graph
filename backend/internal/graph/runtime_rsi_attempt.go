package graph

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

type RsiAttemptRecord struct {
	Id        string   `json:"id"`
	Title     string   `json:"title"`
	Root      string   `json:"root"`
	Branch    string   `json:"branch"`
	BaseHead  string   `json:"baseHead"`
	Paths     []string `json:"paths"`
	StartedAt int64    `json:"startedAt"`
}

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

func (service *RsiService) rsiAttemptPath() string {
	return filepath.Join(service.stateDir, "rsi", "attempt.json")
}

func (service *RsiService) rsiWriteAttempt(record RsiAttemptRecord) error {
	encoded, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return err
	}
	return rsiWriteAtomic(service.rsiAttemptPath(), string(encoded)+"\n")
}

func (service *RsiService) rsiBeginAttempt(id, title, root, branch, baseHead string, paths []string) {
	_ = service.rsiWriteAttempt(RsiAttemptRecord{
		Id: id, Title: title, Root: root, Branch: branch,
		BaseHead: baseHead, Paths: paths, StartedAt: NowMillis(),
	})
}

func (service *RsiService) rsiClearAttempt() {
	_ = os.Remove(service.rsiAttemptPath())
}

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
