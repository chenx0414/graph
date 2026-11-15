package main

import (
	"encoding/json"
	"strings"
)

const chatWaitStatus = "已发出，等待回复…"

type roundPhase int

const (
	roundIdle roundPhase = iota
	roundQueued
	roundPreparing
	roundRunning
	roundBlocked
	roundPaused
)

func (phase roundPhase) busy() bool {
	switch phase {
	case roundPreparing, roundRunning, roundBlocked:
		return true
	}
	return false
}

type messagePhase int

const (
	messagePhaseSettled messagePhase = iota
	messagePhaseQueued
	messagePhasePending
	messagePhaseRunning
	messagePhaseFailed
	messagePhaseCancelled
)

func messagePhaseOf(message transcriptMessage) messagePhase {
	switch message.State {
	case "queued":
		return messagePhaseQueued
	case "pending":
		if message.Role == "tool" {
			return messagePhasePending
		}
		return messagePhaseSettled
	case "delivered":
		if message.Role == "user" {
			return messagePhaseSettled
		}
		return messagePhaseRunning
	case "running", "streaming":
		return messagePhaseRunning
	case "failed", "error":
		return messagePhaseFailed
	case "cancelled":
		return messagePhaseCancelled
	}
	return messagePhaseSettled
}

func (message transcriptMessage) active() bool {
	switch messagePhaseOf(message) {
	case messagePhaseQueued, messagePhasePending, messagePhaseRunning:
		return true
	}
	return false
}

func roundPhaseOf(paused bool, master string, messages []transcriptMessage) roundPhase {
	if paused {
		return roundPaused
	}
	switch master {
	case "preparing":
		return roundPreparing
	case "running":
		return roundRunning
	case "blocked":
		return roundBlocked
	}
	phase := roundIdle
	for _, message := range messages {
		switch messagePhaseOf(message) {
		case messagePhaseRunning, messagePhasePending:
			return roundRunning
		case messagePhaseQueued:
			phase = roundQueued
		}
	}
	return phase
}

func roundAnswered(messages []transcriptMessage) bool {
	lastUser := -1
	for index, message := range messages {
		if message.Role == "user" {
			lastUser = index
		}
	}
	return lastUser >= 0 && lastUser < len(messages)-1
}

func parseRoundMaster(payload []byte) string {
	var body struct {
		Master struct {
			Status string `json:"status"`
		} `json:"master"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	return strings.TrimSpace(body.Master.Status)
}

func (c *chatState) roundPhase() roundPhase {
	return roundPhaseOf(c.paused, c.roundMaster, c.messages)
}
