package graph

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"encoding/json"
)

const reclaimUsage = `Usage: graphd reclaim --state-dir <path> [options]

Reclaims the space old finished work takes in a state directory. It reports by
default; --apply backs the database up first, reclaims, and vacuums afterwards.
It takes the same owner lock the daemon takes, so a state directory a running
Graph owns is refused instead of touched.

Options:
  --state-dir <path>       State directory (required)
  --apply                  Reclaim for real (without it, nothing is changed)
  --keep-events <n>        Events kept per task (default: 200)
  --keep-capabilities <n>  Capability records kept per node (default: 1)
  --keep-handoffs <n>      Context handoffs kept per operation (default: 1)
  --min-age-days <n>       Only work whose last event is older than this (default: 1)
  -h, --help               Print this help`

type reclaimReport struct {
	State      string            `json:"state"`
	File       string            `json:"file"`
	Bytes      int64             `json:"bytes"`
	Plan       RetentionPlan     `json:"plan"`
	Applied    *RetentionApplied `json:"applied,omitempty"`
	Backup     string            `json:"backup,omitempty"`
	BytesAfter int64             `json:"bytesAfter,omitempty"`
}

func reclaimNumber(raw string, name string) int {
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		Raise("usage", name+" must be a non-negative integer")
	}
	return value
}

func runReclaim(args []string, cwd string) int {
	stateDir := ""
	apply := false
	keepEvents, keepCapabilities, keepHandoffs := 200, 1, 1
	minAgeDays := 1
	for index := 0; index < len(args); index++ {
		argument := args[index]
		value := func() string {
			if index+1 >= len(args) {
				Raise("usage", argument+" requires a value")
			}
			index++
			return args[index]
		}
		switch argument {
		case "--state-dir":
			stateDir = value()
		case "--apply":
			apply = true
		case "--keep-events":
			keepEvents = reclaimNumber(value(), argument)
		case "--keep-capabilities":
			keepCapabilities = reclaimNumber(value(), argument)
		case "--keep-handoffs":
			keepHandoffs = reclaimNumber(value(), argument)
		case "--min-age-days":
			minAgeDays = reclaimNumber(value(), argument)
		case "--help", "-h":
			fmt.Fprintln(os.Stdout, reclaimUsage)
			return 0
		default:
			Raise("usage", "Unknown argument: "+argument)
		}
	}
	if stateDir == "" {
		fmt.Fprintln(os.Stderr, reclaimUsage)
		return 2
	}
	stateDir = resolvePath(cwd, stateDir)
	database := filepath.Join(stateDir, "tasks.sqlite")
	release := AcquireOwner(filepath.Join(stateDir, "owner.sqlite"))
	defer release()
	db, err := OpenSQLite(database)
	if err != nil {
		Raise("internal", "The state database could not be opened: "+err.Error())
	}
	defer db.Close()
	options := RetentionOptions{
		Now:                      NowMillis(),
		KeepEventsPerTask:        keepEvents,
		KeepCapabilitiesPerNode:  keepCapabilities,
		KeepHandoffsPerOperation: keepHandoffs,
		MinAgeMs:                 int64(minAgeDays) * int64(24*time.Hour/time.Millisecond),
	}
	report := reclaimReport{State: stateDir, File: database}
	if info, err := os.Stat(database); err == nil {
		report.Bytes = info.Size()
	}
	report.Plan = PlanRetention(db, options)
	if !apply {
		writeReclaimReport(report)
		return 0
	}
	backup := database + ".bak-" + strconv.FormatInt(NowMillis()/1000, 10)
	if err := copyStateFile(database, backup); err != nil {
		Raise("internal", "The state database could not be backed up: "+err.Error())
	}
	report.Backup = backup
	applied := ApplyRetention(db, options)
	report.Applied = &applied
	if _, err := db.Exec("VACUUM"); err != nil {
		Raise("internal", "The state database could not be vacuumed: "+err.Error())
	}
	if info, err := os.Stat(database); err == nil {
		report.BytesAfter = info.Size()
	}
	writeReclaimReport(report)
	return 0
}

func copyStateFile(database string, backup string) error {
	for _, suffix := range []string{"", "-wal", "-shm"} {
		raw, err := os.ReadFile(database + suffix)
		if err != nil {
			if suffix == "" {
				return err
			}
			continue
		}
		if err := os.WriteFile(backup+suffix, raw, 0o600); err != nil {
			return err
		}
	}
	return nil
}

func writeReclaimReport(report reclaimReport) {
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		Raise("internal", "The report could not be written: "+err.Error())
	}
	fmt.Fprintln(os.Stdout, string(raw))
}
