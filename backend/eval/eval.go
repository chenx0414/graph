package eval

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"sync"
	"time"
)

const SchemaVersion = 1

type Layer string

const (
	LayerE2E         Layer = "e2e"
	LayerIntegration Layer = "integration"
)

type Status string

const (
	StatusPassed  Status = "passed"
	StatusFailed  Status = "failed"
	StatusSkipped Status = "skipped"
)

type Case struct {
	Name     string
	Group    string
	Layer    Layer
	Contract string
	Setup    func(t *T)
	Run      func(t *T)
}

type Options struct {
	Layer Layer
	Group string
	Case  string
	Now   func() time.Time
	Out   func(format string, args ...any)
}

type Report struct {
	SchemaVersion int          `json:"schemaVersion"`
	Total         int          `json:"total"`
	Passed        int          `json:"passed"`
	Failed        int          `json:"failed"`
	Skipped       int          `json:"skipped"`
	StartedAt     string       `json:"startedAt"`
	FinishedAt    string       `json:"finishedAt"`
	ElapsedMs     int64        `json:"elapsedMs"`
	Cases         []CaseReport `json:"cases"`
}

type CaseReport struct {
	Name        string            `json:"name"`
	Group       string            `json:"group"`
	Layer       Layer             `json:"layer"`
	Contract    string            `json:"contract,omitempty"`
	Status      Status            `json:"status"`
	ElapsedMs   int64             `json:"elapsedMs"`
	Assertions  []AssertionReport `json:"assertions"`
	Error       string            `json:"error,omitempty"`
	ErrorDetail string            `json:"errorDetail,omitempty"`
	SkipReason  string            `json:"skipReason,omitempty"`
}

type AssertionReport struct {
	Name     string `json:"name"`
	OK       bool   `json:"ok"`
	Expected string `json:"expected"`
	Actual   string `json:"actual"`
}

func (report Report) Succeeded() bool {
	return report.Failed == 0
}

func (report Report) MarshalIndent() ([]byte, error) {
	return json.MarshalIndent(report, "", "  ")
}

func (report Report) Summary() string {
	parts := []string{
		fmt.Sprintf("%d case(s)", report.Total),
		fmt.Sprintf("%d passed", report.Passed),
		fmt.Sprintf("%d failed", report.Failed),
	}
	if report.Skipped > 0 {
		parts = append(parts, fmt.Sprintf("%d skipped", report.Skipped))
	}
	return fmt.Sprintf("%s in %dms", strings.Join(parts, ", "), report.ElapsedMs)
}

type skipSignal struct {
	reason string
}

type failure struct {
	name string
	what string
}

type T struct {
	mutex      sync.Mutex
	assertions []AssertionReport
	failures   []failure
	errorText  string
	errorKind  string
	skipped    string
}

func (t *T) Equal(name string, expected, actual any) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	want, got := render(expected), render(actual)
	record := AssertionReport{Name: name, Expected: want, Actual: got}
	if want != got {
		record.OK = false
		t.assertions = append(t.assertions, record)
		t.failures = append(t.failures, failure{name: name, what: name + ": expected " + want + ", got " + got})
		return
	}
	record.OK = true
	t.assertions = append(t.assertions, record)
}

func (t *T) True(name string, value bool) {
	t.Equal(name, true, value)
}

func (t *T) False(name string, value bool) {
	t.Equal(name, false, value)
}

func (t *T) NotEmpty(name string, values []string) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	ok := len(values) > 0
	record := AssertionReport{Name: name, Expected: "at least one entry", Actual: render(values), OK: ok}
	t.assertions = append(t.assertions, record)
	if !ok {
		t.failures = append(t.failures, failure{name: name, what: name + ": expected at least one entry, got none"})
	}
}

func (t *T) Record(name string, expected, actual any) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	t.assertions = append(t.assertions, AssertionReport{Name: name, Expected: render(expected), Actual: render(actual), OK: true})
}

func (t *T) Fail(name string, err error) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	detail := "assertion"
	if err == nil {
		err = fmt.Errorf("%s failed", name)
	}
	t.assertions = append(t.assertions, AssertionReport{Name: name, Expected: "no error", Actual: err.Error(), OK: false})
	t.failures = append(t.failures, failure{name: name, what: name + ": " + err.Error()})
	t.errorText = err.Error()
	t.errorKind = detail
}

func (t *T) Fatal(name string, err error) {
	t.Fail(name, err)
	panic(skipSignal{reason: name + ": " + err.Error()})
}

func (t *T) TempDirPath() string {
	directory, err := os.MkdirTemp("", "graph-eval-t-")
	if err != nil {
		t.Fatal("temp-dir", err)
	}
	return directory
}

func (t *T) Skip(reason string) {
	panic(skipSignal{reason: reason})
}

func (t *T) failed() bool {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	return len(t.failures) > 0
}

func (t *T) messageLockedValue() string {
	if t.errorText != "" {
		return t.errorText
	}
	lines := make([]string, 0, len(t.failures))
	for _, item := range t.failures {
		lines = append(lines, item.what)
	}
	return strings.Join(lines, "\n")
}

func (t *T) snapshot() ([]AssertionReport, string, string, string) {
	t.mutex.Lock()
	defer t.mutex.Unlock()
	assertions := make([]AssertionReport, len(t.assertions))
	copy(assertions, t.assertions)
	return assertions, t.messageLockedValue(), t.errorKind, t.skipped
}

func render(value any) string {
	if value == nil {
		return "null"
	}
	if text, ok := value.(string); ok {
		return text
	}
	if text, ok := value.(error); ok {
		return text.Error()
	}
	if reflect.TypeOf(value).Kind() == reflect.String {
		return fmt.Sprintf("%v", value)
	}
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf("%v", value)
	}
	return string(payload)
}

func selectCases(cases []Case, options Options) []Case {
	layer := Layer(strings.TrimSpace(strings.ToLower(string(options.Layer))))
	group := strings.TrimSpace(strings.ToLower(options.Group))
	name := strings.TrimSpace(options.Case)
	chosen := make([]Case, 0, len(cases))
	for _, item := range cases {
		if layer != "" && layer != "all" && item.Layer != layer {
			continue
		}
		if group != "" && group != "all" && item.Group != group {
			continue
		}
		if name != "" && item.Name != name {
			continue
		}
		chosen = append(chosen, item)
	}
	return chosen
}
