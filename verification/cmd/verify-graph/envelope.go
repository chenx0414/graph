package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type artifact struct {
	Kind   string `json:"kind"`
	Path   string `json:"path"`
	SHA256 string `json:"sha256,omitempty"`
	Bytes  int64  `json:"bytes,omitempty"`
	Note   string `json:"note,omitempty"`
}

type cliError struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint,omitempty"`
}

type envelope struct {
	Command     string     `json:"command"`
	OK          bool       `json:"ok"`
	RunID       string     `json:"runId,omitempty"`
	Lane        string     `json:"lane,omitempty"`
	Data        any        `json:"data,omitempty"`
	Artifacts   []artifact `json:"artifacts"`
	Warnings    []string   `json:"warnings"`
	NextActions []string   `json:"nextActions"`
	Error       *cliError  `json:"error"`
}

const (
	codeUsage             = "usage"
	codeIsolation         = "isolation-violation"
	codeDaemonDown        = "daemon-unreachable"
	codeUnauthorized      = "unauthorized"
	codeScenarioFailed    = "scenario-failed"
	codeEvidenceCorrupt   = "evidence-corrupt"
	codeBuildFailed       = "build-failed"
	codeNoRun             = "not-launched"
	codeLabelNotFound     = "label-not-found"
	codeJourneyFileBroken = "journey-invalid"
	codeControlsInventory = "controls-inventory-missing"
	codeControlsLedger    = "controls-ledger-missing"
	codeControlsGap       = "controls-unproven"
)

func okEnvelope(command, lane string, data any) envelope {
	return envelope{Command: command, OK: true, Lane: lane, Data: data,
		Artifacts: []artifact{}, Warnings: []string{}, NextActions: []string{}}
}

func failEnvelope(command, lane, code, message, hint string) envelope {
	return envelope{Command: command, OK: false, Lane: lane,
		Artifacts: []artifact{}, Warnings: []string{}, NextActions: []string{},
		Error: &cliError{Code: code, Message: message, Hint: hint}}
}

func (e envelope) print() int {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(e); err != nil {
		fmt.Fprintln(os.Stderr, "verify-graph: cannot write result:", err)
		return 1
	}
	if e.OK {
		return 0
	}
	if e.Error != nil && e.Error.Code == codeUsage {
		return 2
	}
	return 1
}

func (e *envelope) add(a artifact) *envelope {
	e.Artifacts = append(e.Artifacts, a)
	return e
}

func (e *envelope) warn(format string, args ...any) *envelope {
	e.Warnings = append(e.Warnings, fmt.Sprintf(format, args...))
	return e
}

func (e *envelope) next(format string, args ...any) *envelope {
	e.NextActions = append(e.NextActions, fmt.Sprintf(format, args...))
	return e
}
