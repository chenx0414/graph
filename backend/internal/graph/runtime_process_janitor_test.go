package graph

import (
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

const janitorOrphanScript = "while :; do sleep 0.2; done"

func janitorEventually(t *testing.T, predicate func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if predicate() {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func janitorParentOf(t *testing.T, pid int) int {
	t.Helper()
	output, err := exec.Command("ps", "-o", "ppid=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return -1
	}
	parent, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		return -1
	}
	return parent
}

func janitorGroupAlive(pgid int) bool {
	return syscall.Kill(-pgid, 0) == nil
}

func janitorStartOrphan(t *testing.T, script string, extra ...string) int {
	t.Helper()
	line := "nohup sh -c \"" + script + "\" sh"
	if len(extra) > 0 {
		line += " " + strings.Join(extra, " ")
	}
	output, err := exec.Command("sh", "-c", line+" >/dev/null 2>&1 & echo $!").Output()
	if err != nil {
		t.Fatalf("spawn the orphan probe: %v", err)
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(output)))
	if err != nil {
		t.Fatalf("orphan probe pid %q: %v", output, err)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	if !janitorEventually(t, func() bool { return janitorParentOf(t, pid) == 1 }) {
		t.Fatalf("the probe %d never became an orphan", pid)
	}
	return pid
}

func janitorTestOptions() processJanitorOptions {
	return processJanitorOptions{MinAge: 0}
}

func TestJanitorReapsTheGroupLeftBehindByAnEarlierRun(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	command := exec.Command("sh", "-c", "sleep 30 & sleep 30")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatalf("start the recorded command: %v", err)
	}
	pgid := command.Process.Pid
	defer func() { _ = syscall.Kill(-pgid, syscall.SIGKILL) }()
	RecordSpawnGroup(pgid)
	if !janitorGroupAlive(pgid) {
		t.Fatal("the recorded group has to be running before the sweep")
	}
	ReapStaleProcesses(stateDir, janitorTestOptions())
	_ = command.Wait()
	if !janitorEventually(t, func() bool { return !janitorGroupAlive(pgid) }) {
		t.Fatalf("the recorded group %d survived the sweep", pgid)
	}
	if left := spawnGroupLedger(stateDir); len(left) != 0 {
		t.Fatalf("the ledger kept %v after the sweep", left)
	}
}

func TestJanitorLeavesGroupsItNeverStarted(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	command := exec.Command("sh", "-c", "sleep 30")
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		t.Fatalf("start the unrecorded command: %v", err)
	}
	pgid := command.Process.Pid
	defer func() { _ = syscall.Kill(-pgid, syscall.SIGKILL); _, _ = command.Process.Wait() }()
	ReapStaleProcesses(stateDir, janitorTestOptions())
	if !janitorGroupAlive(pgid) {
		t.Fatal("the sweep killed a group Graph never started")
	}
}

func TestJanitorReapsOrphanedBrowsersFromAnEarlierRun(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	pid := janitorStartOrphan(t, janitorOrphanScript, "--user-data-dir=/var/folders/probe/graph-host-browser-audit")
	ReapStaleProcesses(stateDir, janitorTestOptions())
	if !janitorEventually(t, func() bool { return janitorParentOf(t, pid) == -1 }) {
		t.Fatalf("the orphaned browser %d survived the sweep", pid)
	}
}

func janitorMarkedChild(t *testing.T, marker string, parent int) int {
	t.Helper()
	output, _ := exec.Command("sh", "-c", "ps -eww -o pid=,ppid=,command= | grep -F '"+marker+"' | grep -v grep").Output()
	for _, line := range strings.Split(string(output), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		pid, pidError := strconv.Atoi(fields[0])
		ppid, parentError := strconv.Atoi(fields[1])
		if pidError != nil || parentError != nil || pid == parent || ppid == 1 {
			continue
		}
		return pid
	}
	return -1
}

func TestJanitorReapsChildrenOfTheOrphanItKills(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	child := "graph-host-browser-child"
	parent := janitorStartOrphan(t, janitorOrphanScript+" & sh -c 'while :; do sleep 0.2; done' sh --user-data-dir=/var/folders/probe/"+child+" & wait")
	pid := -1
	if !janitorEventually(t, func() bool { pid = janitorMarkedChild(t, child, parent); return pid > 0 }) {
		t.Fatalf("the browser child never started under the orphan %d", parent)
	}
	t.Cleanup(func() { _ = syscall.Kill(pid, syscall.SIGKILL) })
	ReapStaleProcesses(stateDir, janitorTestOptions())
	if !janitorEventually(t, func() bool { return janitorParentOf(t, pid) == -1 }) {
		t.Fatalf("the browser child %d outlived the orphan the sweep killed", pid)
	}
}

func TestJanitorLeavesOrphansWithNoKnownMarker(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	pid := janitorStartOrphan(t, janitorOrphanScript)
	ReapStaleProcesses(stateDir, janitorTestOptions())
	if janitorParentOf(t, pid) != 1 {
		t.Fatalf("the sweep killed an orphan that carries no marker of ours")
	}
}

func TestJanitorLeavesYoungOrphansAlone(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	pid := janitorStartOrphan(t, janitorOrphanScript, "--user-data-dir=/var/folders/probe/graph-host-browser-audit")
	ReapStaleProcesses(stateDir, processJanitorOptions{MinAge: time.Hour})
	if janitorParentOf(t, pid) != 1 {
		t.Fatalf("the sweep killed an orphan younger than the minimum age")
	}
}

func TestSpawnGroupLedgerSurvivesARestart(t *testing.T) {
	stateDir := t.TempDir()
	SetSpawnGroupLedger(stateDir)
	RecordSpawnGroup(424242)
	if groups := spawnGroupLedger(stateDir); len(groups) != 1 || groups[0] != 424242 {
		t.Fatalf("the ledger has to carry the group across a restart, got %v", groups)
	}
	ForgetSpawnGroup(424242)
	if groups := spawnGroupLedger(stateDir); len(groups) != 0 {
		t.Fatalf("a settled command must leave no ledger entry, got %v", groups)
	}
	if _, err := os.Stat(stateDir); err != nil {
		t.Fatalf("the ledger has to stay inside the state directory: %v", err)
	}
}

// ps prints a process's start time in the machine's own zone, so reading it as UTC made a
// process that had just started look hours old - exactly the UTC offset here. The minimum-age
// guard then stopped protecting young processes, which is what this test is about.
func TestTheJanitorReadsProcessAgeInTheLocalZone(t *testing.T) {
	// The layout has no zone, so whichever location it is parsed in decides the instant. The
	// assertion is on the reader the sweep uses, not on a second parse written here: the two
	// must agree, and reading as UTC disagrees by the machine's offset.
	justStarted := time.Now().Add(-30 * time.Second)
	parsed, err := readProcessStart(justStarted.Format(processStartLayout))
	if err != nil {
		t.Fatalf("a ps start time parses: %v", err)
	}
	age := time.Since(parsed)
	if age < 0 || age > 5*time.Minute {
		t.Fatalf("a process started 30s ago reads as %v old, so the minimum-age guard would not hold", age)
	}
}
