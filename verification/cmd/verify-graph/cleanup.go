package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"graph/verification/internal/appinstance"
	"graph/verification/internal/mygoauto"
)

// cleanup.go makes teardown reliable without ever signalling a process this
// tool does not own.
//
// Two rules, both enforced here rather than documented as a limitation:
//   - a pid is only signalled when its command line names this run's directory
//     under verification/.run (and, when a start time was recorded, it still
//     matches) — a recycled pid is never killed;
//   - a run directory is removed whole. The old code removed a hand-written
//     list of children and silently left instance/, ui-motion.json and any
//     directory a later feature added behind, which is why .run/ accumulated
//     dead state.
//
// `cleanup --orphans` finishes the job for runs whose run.json is gone. It is
// deliberately conservative: an unsupervised daemon must be older than
// --older-than (default 120s) so a run that is still starting up is never
// mistaken for garbage.

// runDirForStateDir maps a daemon's --state-dir back to verification/.run/<id>.
// It returns ok=false for anything outside the run root, for the shared bin
// directory, and for paths that are not exactly one run below the root.
func runDirForStateDir(p paths, stateDir string) (string, bool) {
	if stateDir == "" {
		return "", false
	}
	root, err := filepath.Abs(p.RunRoot)
	if err != nil {
		return "", false
	}
	absolute, err := filepath.Abs(stateDir)
	if err != nil {
		return "", false
	}
	prefix := root + string(filepath.Separator)
	if !strings.HasPrefix(absolute, prefix) {
		return "", false
	}
	rest := strings.TrimPrefix(absolute, prefix)
	parts := strings.Split(rest, string(filepath.Separator))
	if len(parts) == 0 || parts[0] == "" || parts[0] == "." || parts[0] == ".." || parts[0] == "bin" {
		return "", false
	}
	return filepath.Join(root, parts[0]), true
}

// parseElapsed understands the two shapes BSD ps prints for -o etime=:
// "[[dd-]hh:]mm:ss".
func parseElapsed(raw string) (time.Duration, bool) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return 0, false
	}
	days := 0
	if cut, rest, found := strings.Cut(value, "-"); found {
		parsed, err := strconv.Atoi(cut)
		if err != nil || parsed < 0 {
			return 0, false
		}
		days = parsed
		value = rest
	}
	parts := strings.Split(value, ":")
	if len(parts) < 2 || len(parts) > 3 {
		return 0, false
	}
	numbers := make([]int, 0, len(parts))
	for _, part := range parts {
		parsed, err := strconv.Atoi(part)
		if err != nil || parsed < 0 {
			return 0, false
		}
		numbers = append(numbers, parsed)
	}
	seconds := 0
	switch len(numbers) {
	case 2:
		seconds = numbers[0]*60 + numbers[1]
	case 3:
		seconds = numbers[0]*3600 + numbers[1]*60 + numbers[2]
	}
	return time.Duration(days)*24*time.Hour + time.Duration(seconds)*time.Second, true
}

func processElapsed(pid int) (time.Duration, bool) {
	if pid <= 0 {
		return 0, false
	}
	output, err := runPS("-o", "etime=", "-p", strconv.Itoa(pid))
	if err != nil {
		return 0, false
	}
	return parseElapsed(output)
}

// runPS is a seam for tests: the rest of this file never shells out directly.
var runPS = func(args ...string) (string, error) {
	output, err := exec.Command("ps", args...).Output()
	return strings.TrimSpace(string(output)), err
}

type orphanTarget struct {
	PID      int    `json:"pid"`
	Start    string `json:"start,omitempty"`
	RunID    string `json:"runId"`
	RunDir   string `json:"runDir"`
	StateDir string `json:"stateDir,omitempty"`
	Command  string `json:"command"`
	AgeSecs  int64  `json:"ageSeconds"`
}

type orphanSkip struct {
	PID     int    `json:"pid,omitempty"`
	RunDir  string `json:"runDir,omitempty"`
	Reason  string `json:"reason"`
	Command string `json:"command,omitempty"`
}

// planOrphans decides, without side effects, which leftovers may be cleaned.
// It never returns a process that belongs to a live run, never one outside the
// run root, and never one younger than minAge.
func planOrphans(p paths, runs []runMeta, daemons []daemonProcess, minAge time.Duration, elapsed func(int) (time.Duration, bool)) ([]orphanTarget, []orphanSkip) {
	live := map[int]bool{}
	liveDirs := map[string]bool{}
	for _, run := range runs {
		if runAlive(run) {
			live[run.Daemon.PID] = true
			if run.RunID != "" {
				liveDirs[filepath.Join(p.RunRoot, run.RunID)] = true
			}
		}
	}
	targets := []orphanTarget{}
	skipped := []orphanSkip{}
	for _, daemon := range daemons {
		if daemon.PID <= 1 {
			continue
		}
		if strings.Contains(daemon.Command, "keeper.sh") {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, Reason: "daemon keeper shell of a run, not the daemon itself", Command: daemon.Command})
			continue
		}
		if live[daemon.PID] {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, Reason: "belongs to a live run", Command: daemon.Command})
			continue
		}
		runDir, ok := runDirForStateDir(p, daemon.StateDir)
		if !ok {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, Reason: "state dir is not inside verification/.run/<id>", Command: daemon.Command})
			continue
		}
		if liveDirs[runDir] {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, RunDir: runDir, Reason: "belongs to a live run", Command: daemon.Command})
			continue
		}
		if !strings.Contains(daemon.Command, runDir) {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, RunDir: runDir, Reason: "command line does not name the run directory", Command: daemon.Command})
			continue
		}
		age, known := elapsed(daemon.PID)
		if !known {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, RunDir: runDir, Reason: "process age is unknown", Command: daemon.Command})
			continue
		}
		if age < minAge {
			skipped = append(skipped, orphanSkip{PID: daemon.PID, RunDir: runDir,
				Reason: fmt.Sprintf("younger than %s (a run may still be starting)", minAge), Command: daemon.Command})
			continue
		}
		targets = append(targets, orphanTarget{
			PID: daemon.PID, Start: daemon.Start, RunID: filepath.Base(runDir), RunDir: runDir,
			StateDir: daemon.StateDir, Command: daemon.Command, AgeSecs: int64(age.Seconds()),
		})
	}
	return targets, skipped
}

// stopOrphan signals exactly one pid after re-reading ps, so a pid that was
// recycled between planning and acting is refused instead of killed.
func stopOrphan(target orphanTarget) error {
	if !alive(target.PID) {
		return nil
	}
	if target.Start != "" && lstart(target.PID) != target.Start {
		return fmt.Errorf("refusing to stop pid %d: its start time changed (pid reuse)", target.PID)
	}
	command := strings.TrimSpace(processCommandLine(target.PID))
	if !strings.Contains(command, target.RunDir) {
		return fmt.Errorf("refusing to stop pid %d: %q does not name %s", target.PID, command, target.RunDir)
	}
	_ = syscall.Kill(target.PID, syscall.SIGTERM)
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(target.PID) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = syscall.Kill(target.PID, syscall.SIGKILL)
	deadline = time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if !alive(target.PID) {
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("pid %d did not exit after SIGTERM and SIGKILL", target.PID)
}

func processCommandLine(pid int) string {
	if pid <= 0 {
		return ""
	}
	output, err := runPS("-o", "command=", "-p", strconv.Itoa(pid))
	if err != nil {
		return ""
	}
	return output
}

// stopRunExtras stops the window processes a run started through the two live
// window lanes. Their records carry an identity check of their own; a missing
// record is simply "nothing to stop".
func stopRunExtras(p paths, meta runMeta) []string {
	notes := []string{}
	root := filepath.Join(p.RunRoot, meta.RunID)
	if fileExists(filepath.Join(root, "instance.json")) {
		instance, err := appinstance.Load(root)
		if err != nil {
			notes = append(notes, "instance.json unreadable: "+err.Error())
		} else if lines := instance.Stop(); len(lines) > 0 {
			notes = append(notes, lines...)
		}
	}
	if fileExists(filepath.Join(root, "ui-motion.json")) {
		record, err := mygoauto.ReadWindow(motionOptions(p, meta))
		if err == nil {
			if err := mygoauto.StopWindow(record); err != nil {
				notes = append(notes, "motion window: "+err.Error())
			} else if record.AppPID > 0 {
				notes = append(notes, fmt.Sprintf("motion window pid %d: stopped", record.AppPID))
			}
		}
	}
	return notes
}

// removeRunDir removes verification/.run/<runId> as a whole. It refuses
// anything that is not exactly one directory below the run root, so a corrupt
// run id can never turn into RemoveAll("../..").
func removeRunDir(p paths, runID string) error {
	if runID == "" || runID != filepath.Base(runID) || runID == "." || runID == ".." || runID == "bin" {
		return fmt.Errorf("refusing to remove run %q: not a single run id", runID)
	}
	root, err := filepath.Abs(p.RunRoot)
	if err != nil {
		return err
	}
	dir, err := filepath.Abs(filepath.Join(root, runID))
	if err != nil {
		return err
	}
	if !strings.HasPrefix(dir, root+string(filepath.Separator)) {
		return fmt.Errorf("refusing to remove %s: outside %s", dir, root)
	}
	return os.RemoveAll(dir)
}

// cleanupOrphansReliable is what `cleanup --orphans` runs. It shares the
// planning rules above and, unlike the first pass, removes the abandoned run
// directory once its daemon is gone, so a second run does not report the same
// leftovers forever.
func cleanupOrphansReliable(p paths, dryRun bool, minAge time.Duration) ([]map[string]any, []string) {
	runs, err := listRuns(p)
	if err != nil {
		return nil, []string{err.Error()}
	}
	targets, skipped := planOrphans(p, runs, scanDaemons(p), minAge, processElapsed)
	report := []map[string]any{}
	failures := []string{}
	for _, skip := range skipped {
		entry := map[string]any{"pid": skip.PID, "skipped": skip.Reason, "command": skip.Command}
		if skip.RunDir != "" {
			entry["runId"] = filepath.Base(skip.RunDir)
			entry["runDir"] = skip.RunDir
		}
		report = append(report, entry)
	}
	for _, target := range targets {
		entry := map[string]any{
			"runId": target.RunID, "pid": target.PID, "stateDir": target.StateDir,
			"ageSeconds": target.AgeSecs, "command": target.Command,
		}
		if dryRun {
			entry["dryRun"] = true
			report = append(report, entry)
			continue
		}
		if err := stopOrphan(target); err != nil {
			entry["error"] = err.Error()
			failures = append(failures, err.Error())
			report = append(report, entry)
			continue
		}
		if err := removeRunDir(p, target.RunID); err != nil {
			entry["error"] = err.Error()
			failures = append(failures, err.Error())
			report = append(report, entry)
			continue
		}
		entry["stopped"] = true
		entry["removed"] = true
		report = append(report, entry)
	}

	active := map[string]bool{}
	for _, run := range runs {
		if runAlive(run) {
			active[run.RunID] = true
		}
	}
	for _, runID := range staleRunDirs(p, active, minAge) {
		entry := map[string]any{"runId": runID, "stale": true}
		if dryRun {
			entry["dryRun"] = true
			report = append(report, entry)
			continue
		}
		if err := removeRunDir(p, runID); err != nil {
			entry["error"] = err.Error()
			failures = append(failures, err.Error())
		} else {
			entry["removed"] = true
		}
		report = append(report, entry)
	}
	return report, failures
}

// staleRunDirs lists run directories that no live run and no live process own.
// A directory whose newest entry is younger than minAge is left alone: a
// concurrent `verify` may be in the middle of creating it.
func staleRunDirs(p paths, active map[string]bool, minAge time.Duration) []string {
	entries, err := os.ReadDir(p.RunRoot)
	if err != nil {
		return nil
	}
	stale := []string{}
	for _, entry := range entries {
		if !entry.IsDir() || entry.Name() == "bin" || active[entry.Name()] {
			continue
		}
		info, err := entry.Info()
		if err != nil || time.Since(info.ModTime()) < minAge {
			continue
		}
		if processMentions(filepath.Join(p.RunRoot, entry.Name())) {
			continue
		}
		stale = append(stale, entry.Name())
	}
	return stale
}

func processMentions(path string) bool {
	output, err := exec.Command("pgrep", "-f", path).Output()
	return err == nil && strings.TrimSpace(string(output)) != ""
}
