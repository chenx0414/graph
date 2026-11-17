package mygoauto

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"graph/verification/internal/guard"
)

// Baseline is the user's Graph state a verification run must never change.
// It is internal/guard's fingerprint, so the window lane and every other lane
// answer "did we touch the user's install?" the same way.
type Baseline = guard.Fingerprint

func (o Options) Baseline() Baseline { return guard.Capture(o.UserHome, o.RepoRoot) }

func (s *Session) launchctlCalls() string {
	payload, err := os.ReadFile(s.opts.stubLog())
	if err != nil {
		return ""
	}
	return string(payload)
}

// GlobalReport is the before/after fingerprint plus what the launchctl shadow
// recorded. A reviewer reads this instead of trusting a claim.
type GlobalReport struct {
	Before       Baseline       `json:"before"`
	After        Baseline       `json:"after"`
	Changes      []guard.Change `json:"changes"`
	LaunchctlLog string         `json:"launchctlLogCalls"`
	Unchanged    bool           `json:"unchanged"`
	ShimLog      string         `json:"shimLog"`
	SandboxHome  string         `json:"sandboxedHome"`
	RecordedAt   time.Time      `json:"recordedAt"`
}

func (o Options) baselinePath() string { return filepath.Join(o.RunDir, "global-baseline.json") }

// SaveBaseline records the user's Graph fingerprint before the window starts,
// so a later command (a separate process) can still prove the run left it
// alone.
func (s *Session) SaveBaseline() error {
	payload, err := json.MarshalIndent(s.baseline, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.opts.baselinePath(), append(payload, '\n'), 0o644)
}

func (s *Session) loadBaseline() {
	if !s.baseline.CapturedAt.IsZero() {
		return
	}
	payload, err := os.ReadFile(s.opts.baselinePath())
	if err != nil {
		return
	}
	var fingerprint Baseline
	if json.Unmarshal(payload, &fingerprint) == nil {
		s.baseline = fingerprint
	}
}

func (s *Session) GlobalReport() GlobalReport {
	s.loadBaseline()
	after := s.opts.Baseline()
	report := GlobalReport{
		Before:       s.baseline,
		After:        after,
		Changes:      guard.Diff(s.baseline, after),
		LaunchctlLog: s.launchctlCalls(),
		ShimLog:      s.opts.stubLog(),
		SandboxHome:  s.opts.homeDir(),
		RecordedAt:   time.Now().UTC(),
	}
	report.Unchanged = len(report.Changes) == 0 && strings.TrimSpace(report.LaunchctlLog) == ""
	return report
}

// VerifyGlobal fails when the run changed the user's Graph supervision or when
// the app reached launchctl: both mean the isolation did not hold.
func (s *Session) VerifyGlobal() error {
	report := s.GlobalReport()
	problems := []string{}
	for _, change := range report.Changes {
		problems = append(problems, fmt.Sprintf("%s: %s -> %s", change.Field, change.Before, change.After))
	}
	if strings.TrimSpace(report.LaunchctlLog) != "" {
		problems = append(problems, "launchctl reached the system through the shadow: "+firstLine(report.LaunchctlLog))
	}
	if len(problems) == 0 {
		return nil
	}
	return fmt.Errorf("mygoauto: the run changed the user's Graph state: %s", strings.Join(problems, "; "))
}

func firstLine(value string) string {
	if index := strings.IndexByte(value, '\n'); index >= 0 {
		return value[:index]
	}
	return value
}

func (s *Session) writeEvidence(name string, value any) (string, error) {
	dir := s.opts.EvidenceDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	payload, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return "", err
	}
	path := name
	if !filepath.IsAbs(path) {
		path = filepath.Join(dir, name)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, append(payload, '\n'), 0o644); err != nil {
		return "", err
	}
	return fileSHA(path)
}

// SaveEvidence writes one JSON proof under the run's evidence directory and
// returns its sha256.
func (s *Session) SaveEvidence(name string, value any) (string, error) {
	return s.writeEvidence(name, value)
}

// SaveTree writes the current accessibility tree and returns its size and
// sha256, so a proof carries the exact frame an assertion was made on.
func (s *Session) SaveTree(ctx context.Context, name string) (int, string, error) {
	nodes, err := s.Tree(ctx)
	if err != nil {
		return 0, "", err
	}
	digest, err := s.writeEvidence(name, nodes)
	return len(nodes), digest, err
}

func (s *Session) SaveGlobalReport() (string, error) {
	return s.writeEvidence("global.json", s.GlobalReport())
}

// UserInstancePID reports the daemon a user's own Graph published, so a caller
// can print it before and after without ever driving it.
func (s *Session) UserInstancePID() (int, bool) {
	payload, err := os.ReadFile(s.opts.userConsole())
	if err != nil {
		return 0, false
	}
	var console struct {
		PID int `json:"pid"`
	}
	if json.Unmarshal(payload, &console) != nil || console.PID <= 0 {
		return 0, false
	}
	return console.PID, true
}
