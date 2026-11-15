package main

import "testing"

func TestWorkStatusAliasesCollapseToOnePhase(t *testing.T) {
	for raw, want := range map[string]workStatus{
		"":           workUnknown,
		"idle":       workIdle,
		"pending":    workPending,
		"queued":     workPending,
		"preparing":  workPending,
		"starting":   workPending,
		"dispatched": workPending,
		"reserved":   workPending,
		"running":    workRunning,
		"chatting":   workRunning,
		"discussing": workRunning,
		"active":     workRunning,
		"streaming":  workRunning,
		"blocked":    workBlocked,
		"waiting":    workBlocked,
		"paused":     workBlocked,
		"failed":     workFailed,
		"error":      workFailed,
		"done":       workDone,
		"completed":  workDone,
		"succeeded":  workDone,
		"settled":    workDone,
		"skipped":    workDone,
		"retired":    workDone,
		"stopped":    workStopped,
		"stopping":   workStopped,
		"cancelled":  workStopped,
		"abandoned":  workStopped,
		"Running":    workRunning,
		" custom ":   workUnknown,
		"custom":     workUnknown,
	} {
		if got := workStatusOf(raw); got != want {
			t.Fatalf("status %q reads %q, want %q", raw, got, want)
		}
	}
}

func TestWorkStatusTerminalityAndLabelsAgree(t *testing.T) {
	for status, terminal := range map[workStatus]bool{
		workIdle:    false,
		workPending: false,
		workRunning: false,
		workBlocked: false,
		workFailed:  true,
		workDone:    true,
		workStopped: true,
		workUnknown: false,
	} {
		if got := status.Terminal(); got != terminal {
			t.Fatalf("status %q terminal %v, want %v", status, got, terminal)
		}
	}
	for status, label := range map[workStatus]string{
		workIdle:    "空闲",
		workPending: "等待",
		workRunning: "运行中",
		workBlocked: "阻塞",
		workFailed:  "失败",
		workDone:    "完成",
		workStopped: "已停止",
		workUnknown: "",
	} {
		if got := status.Label(); got != label {
			t.Fatalf("status %q labels %q, want %q", status, got, label)
		}
	}
}

func TestEveryPhaseExceptUnknownHasATone(t *testing.T) {
	for _, status := range []workStatus{workIdle, workPending, workRunning, workBlocked, workFailed, workDone, workStopped} {
		if tone := toneOf(status); tone == "" {
			t.Fatalf("status %q has no tone", status)
		}
	}
	if tone := toneOf(workUnknown); tone != toneIdle {
		t.Fatalf("an unknown status must stay quiet, got %q", tone)
	}
}

func TestUnknownStatusesStayReadable(t *testing.T) {
	for raw, want := range map[string]string{
		"":           "未知",
		"custom":     "custom",
		"in_review":  "in_review",
		"completed ": "完成",
	} {
		if got := fleetStatusLabel(raw); got != want {
			t.Fatalf("status %q reads %q, want %q", raw, got, want)
		}
	}
	if got := trajectoryStatusLabel(""); got != "完成" {
		t.Fatalf("an empty trajectory status is a finished turn, got %q", got)
	}
	if got := trajectoryStatusLabel("failed"); got != "失败" {
		t.Fatalf("a failed turn reads %q", got)
	}
	if got := trajectoryStatusLabel("in_review"); got != "in_review" {
		t.Fatalf("an unknown turn status stays readable, got %q", got)
	}
}
