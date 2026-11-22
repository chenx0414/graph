package graph

import (
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

const spawnGroupLedgerName = "spawn-groups"

type processJanitorOptions struct {
	MinAge time.Duration
}

var defaultProcessJanitorOptions = processJanitorOptions{MinAge: time.Minute}

var processJanitorMarkers = []string{
	"graph-host-browser-",
	".agent-browser/browsers/",
	"/agent-browser/bin/agent-browser",
}

var spawnGroupLedgerDir = struct {
	mutex sync.Mutex
	path  string
}{}

func SetSpawnGroupLedger(stateDir string) {
	path := ""
	if strings.TrimSpace(stateDir) != "" {
		path = filepath.Join(stateDir, spawnGroupLedgerName)
	}
	spawnGroupLedgerDir.mutex.Lock()
	spawnGroupLedgerDir.path = path
	spawnGroupLedgerDir.mutex.Unlock()
}

func spawnGroupLedgerPath() string {
	spawnGroupLedgerDir.mutex.Lock()
	defer spawnGroupLedgerDir.mutex.Unlock()
	return spawnGroupLedgerDir.path
}

func RecordSpawnGroup(pgid int) {
	path := spawnGroupLedgerPath()
	if path == "" || pgid <= 1 {
		return
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(path, strconv.Itoa(pgid)), []byte(strconv.Itoa(pgid)+"\n"), 0o600)
}

func ForgetSpawnGroup(pgid int) {
	path := spawnGroupLedgerPath()
	if path == "" || pgid <= 1 {
		return
	}
	_ = os.Remove(filepath.Join(path, strconv.Itoa(pgid)))
}

func spawnGroupLedger(stateDir string) []int {
	entries, err := os.ReadDir(filepath.Join(stateDir, spawnGroupLedgerName))
	if err != nil {
		return nil
	}
	groups := []int{}
	for _, entry := range entries {
		pgid, err := strconv.Atoi(entry.Name())
		if err != nil || pgid <= 1 {
			continue
		}
		groups = append(groups, pgid)
	}
	sort.Ints(groups)
	return groups
}

type processEntry struct {
	Pid     int
	Parent  int
	Pgid    int
	Elapsed int64
	Command string
}

const processStartLayout = "Mon Jan _2 15:04:05 2006"

func readProcessStart(printed string) (time.Time, error) {
	return time.ParseInLocation(processStartLayout, printed, time.Local)
}

func listProcessEntries() []processEntry {
	command := exec.Command("ps", "-eww", "-o", "pid=,ppid=,pgid=,lstart=,command=")
	command.Env = append(os.Environ(), "LC_ALL=C", "LANG=C")
	output, err := command.Output()
	if err != nil {
		return nil
	}
	now := time.Now()
	entries := []processEntry{}
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 9 {
			continue
		}
		pid, pidError := strconv.Atoi(fields[0])
		parent, parentError := strconv.Atoi(fields[1])
		pgid, pgidError := strconv.Atoi(fields[2])
		started, startError := readProcessStart(strings.Join(fields[3:8], " "))
		if pidError != nil || parentError != nil || pgidError != nil || startError != nil {
			continue
		}
		entries = append(entries, processEntry{
			Pid: pid, Parent: parent, Pgid: pgid, Elapsed: int64(now.Sub(started) / time.Second),
			Command: strings.Join(fields[8:], " "),
		})
	}
	return entries
}

func processJanitorMarked(command string) bool {
	for _, marker := range processJanitorMarkers {
		if strings.Contains(command, marker) {
			return true
		}
	}
	return false
}

func killStaleProcessGroup(pgid int) bool {
	if pgid <= 1 {
		return false
	}
	return syscall.Kill(-pgid, syscall.SIGKILL) == nil
}

func ReapStaleProcesses(stateDir string, options processJanitorOptions) []int {
	reaped := []int{}
	ledgerPath := filepath.Join(stateDir, spawnGroupLedgerName)
	for _, pgid := range spawnGroupLedger(stateDir) {
		if killStaleProcessGroup(pgid) {
			reaped = append(reaped, pgid)
		}
		_ = os.Remove(filepath.Join(ledgerPath, strconv.Itoa(pgid)))
	}
	self := os.Getpid()
	own, ownError := syscall.Getpgid(self)
	if ownError != nil {
		own = self
	}
	stale := func(entry processEntry, killed map[int]bool) bool {
		if entry.Parent == 1 {
			return true
		}
		return killed[entry.Parent]
	}
	killStale := func(entry processEntry) bool {
		if entry.Pgid == entry.Pid && entry.Pgid != own {
			return killStaleProcessGroup(entry.Pgid)
		}
		return syscall.Kill(entry.Pid, syscall.SIGKILL) == nil
	}
	killed := map[int]bool{}
	entries := listProcessEntries()
	for round := 0; round < 4; round++ {
		progress := false
		for _, entry := range entries {
			if entry.Pgid <= 1 || entry.Pid == self || killed[entry.Pid] {
				continue
			}
			if options.MinAge > 0 && entry.Elapsed*int64(time.Second) < int64(options.MinAge) {
				continue
			}
			if !processJanitorMarked(entry.Command) || !stale(entry, killed) {
				continue
			}
			progress = true
			if killStale(entry) {
				reaped = append(reaped, entry.Pid)
			}
			killed[entry.Pid] = true
		}
		if !progress {
			break
		}
	}
	return reaped
}
