package graph

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"time"
)

const (
	deferredToolThresholdDefaultMs = 30_000
	deferredToolThresholdEnv       = "GRAPH_DEFER_THRESHOLD_MS"
)

func deferredToolThresholdMs() int {
	raw := os.Getenv(deferredToolThresholdEnv)
	if raw == "" {
		return deferredToolThresholdDefaultMs
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < 0 {
		return deferredToolThresholdDefaultMs
	}
	return value
}

type autoToolAdmission struct {
	Store       *TaskStore
	Request     AgentSessionRequest
	Definition  ToolDefinition
	Params      map[string]any
	Gate        SendGate
	ThresholdMs int
}

func deferredToolAutoHandsOff(definition ToolDefinition, params map[string]any) bool {
	if definition.Deferred == nil || definition.Execute == nil {
		return false
	}
	threshold := deferredToolThresholdMs()
	if threshold <= 0 {
		return false
	}
	return deferredToolBudgetMs(params) > threshold
}

func runToolWithHandoff(input autoToolAdmission, ctx context.Context) (any, error) {
	callId := graphUUID()
	job := &deferredToolJob{
		signal: NewAbortSignal(), gate: input.Gate, callId: callId,
		done: make(chan struct{}), settled: make(chan struct{}),
	}
	rows := make(chan DeferredToolCall, 1)
	input.Gate.Dispatch(callId, 0, func() any { return nil })
	go runAutoToolBody(input, job, rows)
	threshold := time.NewTimer(time.Duration(input.ThresholdMs) * time.Millisecond)
	defer threshold.Stop()
	for {
		select {
		case <-job.settled:
			input.Gate.Settle(callId, &TokenUsage{})
			rows <- DeferredToolCall{}
			return autoToolInlineResult(job)
		case <-threshold.C:
			call, failure := bindAutoToolRow(input, job)
			if failure != nil {
				threshold.Stop()
				continue
			}
			rows <- call
			return deferredToolReceipt(call), nil
		case <-ctx.Done():
			input.Gate.Settle(callId, &TokenUsage{})
			job.signal.Abort()
			rows <- DeferredToolCall{}
			return nil, fmt.Errorf("the turn ended before the command finished: %w", ctx.Err())
		}
	}
}

func runAutoToolBody(input autoToolAdmission, job *deferredToolJob, rows chan DeferredToolCall) {
	defer func() { _ = recover() }()
	defer close(job.done)
	defer armDeferredToolDeadline(job, deferredToolBudgetMs(input.Params))()
	value, err, raised := runAutoToolValue(input, job)
	job.mutex.Lock()
	job.value, job.failure, job.raised, job.finished = value, err, raised, true
	job.mutex.Unlock()
	close(job.settled)
	call := <-rows
	if call.Id == "" {
		defer func() { releaseDeferredToolJob(job.id) }()
		return
	}
	defer func() { releaseDeferredToolJob(call.Id) }()
	defer forgetDeferredToolStart(input.Request.ExecutionId, input.Definition.Name, input.Params, call.Id)
	budget := deferredToolBudgetMs(input.Params)
	finalizeDeferredToolCall(input.Store, call, deferredToolOutcomeFor(job, call, budget, value, err, raised))
}

func runAutoToolValue(input autoToolAdmission, job *deferredToolJob) (value any, err error, raised any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			raised = recovered
		}
	}()
	value, err = input.Definition.Deferred(job.callId, input.Params, job.signal)
	return value, err, nil
}

func autoToolInlineResult(job *deferredToolJob) (any, error) {
	job.mutex.Lock()
	defer job.mutex.Unlock()
	if job.raised != nil {
		return nil, errors.New(deferredToolPanicReason(job.raised))
	}
	if job.failure != nil {
		return nil, job.failure
	}
	return job.value, nil
}

func bindAutoToolRow(input autoToolAdmission, job *deferredToolJob) (DeferredToolCall, error) {
	record, failure := recordDeferredToolCall(deferredToolAdmission{
		Store: input.Store, Request: input.Request, Definition: input.Definition,
		Params: input.Params, Gate: input.Gate, CallId: job.callId,
	})
	if failure != nil {
		return DeferredToolCall{}, failure
	}
	if record.row.Id == "" {
		return DeferredToolCall{}, fmt.Errorf("the background call was not recorded")
	}
	job.id = record.row.Id
	registerDeferredToolJob(job)
	return record.row, nil
}
