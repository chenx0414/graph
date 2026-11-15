package main

import "strings"

type workStatus string

type statusTone string

const (
	toneIdle      statusTone = "idle"
	toneActive    statusTone = "active"
	toneAttention statusTone = "attention"
	toneSuccess   statusTone = "success"
	toneDanger    statusTone = "danger"
)

const (
	workIdle    workStatus = "idle"
	workPending workStatus = "pending"
	workRunning workStatus = "running"
	workBlocked workStatus = "blocked"
	workFailed  workStatus = "failed"
	workDone    workStatus = "done"
	workStopped workStatus = "stopped"
	workUnknown workStatus = "unknown"
)

var workStatusAliases = map[string]workStatus{
	"idle":       workIdle,
	"pending":    workPending,
	"queued":     workPending,
	"preparing":  workPending,
	"starting":   workPending,
	"dispatched": workPending,
	"reserved":   workPending,
	"running":    workRunning,
	"chatting":   workRunning,
	"completing": workRunning,
	"verifying":  workRunning,
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
	"canceled":   workStopped,
	"abandoned":  workStopped,
}

var workStatusLabels = map[workStatus]string{
	workIdle:    "空闲",
	workPending: "等待",
	workRunning: "运行中",
	workBlocked: "阻塞",
	workFailed:  "失败",
	workDone:    "完成",
	workStopped: "已停止",
}

func workStatusOf(raw string) workStatus {
	if phase, ok := workStatusAliases[strings.ToLower(strings.TrimSpace(raw))]; ok {
		return phase
	}
	return workUnknown
}

func (phase workStatus) Label() string {
	return workStatusLabels[phase]
}

func (phase workStatus) Terminal() bool {
	switch phase {
	case workDone, workFailed, workStopped:
		return true
	}
	return false
}

func toneOf(phase workStatus) statusTone {
	switch phase {
	case workRunning:
		return toneActive
	case workDone:
		return toneSuccess
	case workFailed:
		return toneDanger
	case workPending, workBlocked:
		return toneAttention
	}
	return toneIdle
}
