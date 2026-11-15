package main

import (
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestDaemonPhaseTransitions(t *testing.T) {
	cases := []struct {
		from  daemonPhase
		event daemonEvent
		want  daemonPhase
		ok    bool
	}{
		{daemonStopped, daemonEventStart, daemonStarting, true},
		{daemonStarting, daemonEventStartedSupervised, daemonLaunchd, true},
		{daemonStarting, daemonEventStartedOwned, daemonOwned, true},
		{daemonStarting, daemonEventStartFailed, daemonStopped, true},
		{daemonOwned, daemonEventExited, daemonStopped, true},
		{daemonOwned, daemonEventStop, daemonStopping, true},
		{daemonAdopted, daemonEventStop, daemonStopping, true},
		{daemonStopping, daemonEventStopped, daemonStopped, true},
		{daemonLaunchd, daemonEventStop, daemonStopped, true},
		{daemonStopped, daemonEventAdopt, daemonAdopted, true},
		{daemonLaunchd, daemonEventAdopt, daemonLaunchd, true},
		{daemonStopped, daemonEventExited, daemonStopped, false},
		{daemonLaunchd, daemonEventExited, daemonLaunchd, false},
		{daemonOwned, daemonEventStart, daemonOwned, false},
		{daemonStarting, daemonEventStop, daemonStarting, false},
	}
	for _, want := range cases {
		got, ok := daemonTransition(want.from, want.event)
		if got != want.want || ok != want.ok {
			t.Fatalf("%s + %s = (%s, %v), want (%s, %v)", want.from, want.event, got, ok, want.want, want.ok)
		}
	}
}

func TestEveryDaemonPhaseHasItsOwnLabel(t *testing.T) {
	seen := map[string]daemonPhase{}
	for _, phase := range []daemonPhase{
		daemonStopped, daemonStarting, daemonLaunchd,
		daemonOwned, daemonAdopted, daemonStopping,
	} {
		label := phase.Label()
		if label == "" || label == "未知" {
			t.Fatalf("%q has no label", phase)
		}
		if other, ok := seen[label]; ok {
			t.Fatalf("%q and %q share the label %q", other, phase, label)
		}
		seen[label] = phase
	}
	if daemonPhase("invented").Label() != "未知" {
		t.Fatal("an unknown phase must stay readable instead of silently claiming a state")
	}
}

func TestANewDaemonIsStopped(t *testing.T) {
	status := newDaemon(Paths{StateDir: t.TempDir()}).status()
	if status.Phase != daemonStopped || status.Pid != 0 || status.Supervised {
		t.Fatalf("a fresh daemon reports %+v", status)
	}
}

func TestAdoptingAProcessMovesTheDaemonToAdopted(t *testing.T) {
	command := exec.Command("sleep", "30")
	if err := command.Start(); err != nil {
		t.Skip("cannot start a probe process: ", err)
	}
	pid := command.Process.Pid
	reaped := make(chan struct{})
	go func() {
		_, _ = command.Process.Wait()
		close(reaped)
	}()
	d := newDaemon(Paths{StateDir: t.TempDir()})
	d.adopt(pid)
	status := d.status()
	if status.Phase != daemonAdopted || status.Pid != pid {
		t.Fatalf("an adopted process reports %+v", status)
	}
	if !d.running() {
		t.Fatal("an adopted daemon that is alive must count as running")
	}
	d.stop()
	if got := d.status().Phase; got != daemonStopped {
		t.Fatalf("after stop the daemon reports %q", got)
	}
	select {
	case <-reaped:
	case <-time.After(8 * time.Second):
		_ = command.Process.Kill()
		t.Fatal("stop left the adopted daemon running")
	}
}

func TestASupervisedDaemonIsNeverAdopted(t *testing.T) {
	d := newDaemon(Paths{StateDir: t.TempDir()})
	d.advance(daemonEventStart)
	d.advance(daemonEventStartedSupervised)
	d.adopt(4242)
	status := d.status()
	if status.Phase != daemonLaunchd || status.Pid != 0 {
		t.Fatalf("launchd owns the process, the window must not adopt it: %+v", status)
	}
	d.stop()
	if got := d.status().Phase; got != daemonStopped {
		t.Fatalf("stopping a supervised daemon reports %q", got)
	}
}

func TestRestartingNeedsAPhaseThisWindowCanReach(t *testing.T) {
	d := newDaemon(Paths{StateDir: filepath.Join(t.TempDir(), "state")})
	if _, message := d.restart(false); message == "" {
		t.Fatal("a daemon this window never started must explain why it cannot restart it")
	}
}
