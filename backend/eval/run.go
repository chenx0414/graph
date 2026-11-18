package eval

import (
	"strings"
	"time"
)

func Run(cases []Case, options Options) (report Report) {
	now := options.Now
	if now == nil {
		now = time.Now
	}
	chosen := selectCases(cases, options)
	started := now()
	report = Report{
		SchemaVersion: SchemaVersion,
		Total:         len(chosen),
		StartedAt:     started.UTC().Format(time.RFC3339),
		Cases:         make([]CaseReport, 0, len(chosen)),
	}
	for _, item := range chosen {
		begin := now()
		record := runCase(item, options)
		record.ElapsedMs = now().Sub(begin).Milliseconds()
		if record.ElapsedMs < 0 {
			record.ElapsedMs = 0
		}
		switch record.Status {
		case StatusPassed:
			report.Passed++
		case StatusFailed:
			report.Failed++
		case StatusSkipped:
			report.Skipped++
		}
		report.Cases = append(report.Cases, record)
		if options.Out != nil {
			options.Out("%s %s (%s)\n", statusMark(record.Status), record.Name, record.Group)
		}
	}
	finished := now()
	report.FinishedAt = finished.UTC().Format(time.RFC3339)
	report.ElapsedMs = finished.Sub(started).Milliseconds()
	if report.ElapsedMs < 0 {
		report.ElapsedMs = 0
	}
	return report
}

func statusMark(status Status) string {
	switch status {
	case StatusPassed:
		return "ok  "
	case StatusSkipped:
		return "skip"
	}
	return "FAIL"
}

func runCase(item Case, options Options) (record CaseReport) {
	record = CaseReport{
		Name:       item.Name,
		Group:      item.Group,
		Layer:      item.Layer,
		Contract:   item.Contract,
		Status:     StatusPassed,
		Assertions: []AssertionReport{},
	}
	harness := &T{}
	defer func() {
		recovered := recover()
		assertions, message, kind, skipped := harness.snapshot()
		record.Assertions = assertions
		if signal, ok := recovered.(skipSignal); ok {
			record.Status = StatusSkipped
			record.SkipReason = signal.reason
		} else if recovered != nil {
			record.Status = StatusFailed
			record.ErrorDetail = "panic"
			record.Error = strings.TrimSpace(message + "\n" + describeRecovered(recovered))
		}
		if skipped != "" && recovered == nil {
			record.Status = StatusSkipped
			record.SkipReason = skipped
		}
		if record.Status == StatusSkipped {
			record.Error = ""
			record.ErrorDetail = ""
			return
		}
		if record.Status != StatusFailed && harness.failed() {
			record.Status = StatusFailed
			record.Error = strings.TrimSpace(message)
			record.ErrorDetail = kind
		}
		if record.Status == StatusFailed {
			if record.Error == "" {
				record.Error = "the case failed without a recorded assertion"
			}
			if record.ErrorDetail == "" {
				record.ErrorDetail = "assertion"
			}
		}
	}()
	if item.Setup != nil {
		item.Setup(harness)
	}
	if harness.failed() {
		return
	}
	if item.Run != nil {
		item.Run(harness)
	}
	return
}

func describeRecovered(recovered any) string {
	if err, ok := recovered.(error); ok {
		return err.Error()
	}
	if text, ok := recovered.(string); ok {
		return text
	}
	return "the case panicked"
}
