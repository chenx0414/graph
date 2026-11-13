package graph

import (
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
)

const fleetScaleAgents = 1024

func TestFleetRunsOneThousandTwentyFourAgentsThroughExecution(t *testing.T) {
	limits := &TaskRuntimeLimits{
		MaxAgents:        fleetScaleAgents,
		SpawnDepth:       DefaultSpawnDepth,
		ChildrenPerAgent: fleetScaleAgents,
	}
	taskRuntime := spawnRuntime(t, limits)
	taskRuntime.store.DB.SetMaxOpenConns(1)
	taskRuntime.store.DB.SetMaxIdleConns(1)
	taskRuntime.master.Action = "collaborate"
	taskRuntime.store.SetExecutionLimits(fleetScaleAgents, DefaultProgramExecutions)

	parent := AgentSpawnParent{AgentId: "global", ProjectId: "p1", Workspace: t.TempDir()}
	tasks := make([]string, 0, fleetScaleAgents)
	for index := 0; index < fleetScaleAgents; index++ {
		receipt := taskRuntime.SpawnAgent(parent, AgentSpawnInput{
			Objective: fmt.Sprintf("fleet objective %d", index),
			Name:      fmt.Sprintf("worker-%d", index),
		}).(map[string]any)
		tasks = append(tasks, kernelString(receipt["taskId"]))
	}

	entered := make(chan string, fleetScaleAgents)
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseAll := func() { releaseOnce.Do(func() { close(release) }) }
	reserve := 1
	execution := NewExecution(taskRuntime.store, map[string]ActionAdapter{
		"collaborate": {
			Kind:          "agent",
			ReserveTokens: &reserve,
			Prepare: func(operation Operation) func() OperationResult {
				return func() OperationResult {
					WaitForAgentExecutionSlot(taskRuntime.store, operation.Id, NewAbortSignal())
					entered <- operation.Id
					<-release
					return OperationResult{Outcome: "completed", Output: map[string]any{"text": operation.TaskId}}
				}
			},
		},
	}, ExecutionExtras{})
	taskRuntime.execution = execution

	finished := make(chan ExecutionDispatch, 1)
	failed := make(chan any, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer func() {
			if recovered := recover(); recovered != nil {
				select {
				case failed <- recovered:
				default:
				}
			}
		}()
		finished <- execution.RunReady()
	}()
	t.Cleanup(func() {
		releaseAll()
		select {
		case <-done:
		case <-time.After(3 * time.Minute):
		}
		execution.Drain()
	})

	seen := map[string]struct{}{}
	deadline := time.NewTimer(5 * time.Minute)
	defer deadline.Stop()
	for len(seen) < fleetScaleAgents {
		select {
		case id := <-entered:
			if _, duplicate := seen[id]; duplicate {
				t.Fatalf("operation %s entered dispatch twice", id)
			}
			seen[id] = struct{}{}
		case recovered := <-failed:
			t.Fatalf("execution failed before %d agents entered dispatch: %v", fleetScaleAgents, recovered)
		case <-deadline.C:
			t.Fatalf("only %d of %d agents entered dispatch together", len(seen), fleetScaleAgents)
		}
	}
	if used := taskRuntime.store.ExecutionSlotsUsed("agent"); used != fleetScaleAgents {
		t.Fatalf("configured execution slots held at once = %d, want %d", used, fleetScaleAgents)
	}
	if waiting := taskRuntime.store.ExecutionSlotsWaiting("agent"); waiting != 0 {
		t.Fatalf("agents queued behind the configured limit: %d", waiting)
	}
	var stats runtime.MemStats
	runtime.ReadMemStats(&stats)
	t.Logf("concurrent=%d goroutines=%d heapAllocMiB=%.1f", fleetScaleAgents, runtime.NumGoroutine(), float64(stats.HeapAlloc)/(1024*1024))
	releaseAll()

	var dispatch ExecutionDispatch
	select {
	case dispatch = <-finished:
	case recovered := <-failed:
		t.Fatalf("execution failed after the agents entered dispatch: %v", recovered)
	case <-time.After(5 * time.Minute):
		t.Fatal("the agents did not finish after the dispatch barrier released")
	}
	if dispatch.Dispatched != fleetScaleAgents {
		t.Fatalf("dispatched = %d, want %d", dispatch.Dispatched, fleetScaleAgents)
	}
	assertFleetExecutionResults(t, taskRuntime.store, tasks, seen)
}

func assertFleetExecutionResults(t *testing.T, store *TaskStore, tasks []string, operations map[string]struct{}) {
	t.Helper()
	rows := kernelRows(store.Db, "SELECT id, task_id, state, json_extract(spec,'$.kind') AS kind FROM operations")
	byTask := map[string]string{}
	for _, row := range rows {
		taskID := kernelString(row["task_id"])
		if _, exists := byTask[taskID]; exists {
			t.Fatalf("task %s settled more than one operation", taskID)
		}
		id := kernelString(row["id"])
		if kernelString(row["state"]) != "succeeded" || kernelString(row["kind"]) != "agent" {
			t.Fatalf("operation %s state = %s kind = %s", id, kernelString(row["state"]), kernelString(row["kind"]))
		}
		if _, held := operations[id]; !held {
			t.Fatalf("operation %s was not inside the dispatch barrier", id)
		}
		byTask[taskID] = id
	}
	if len(byTask) != len(tasks) {
		t.Fatalf("succeeded operations = %d, want %d", len(byTask), len(tasks))
	}
	for _, taskID := range tasks {
		operationID, ok := byTask[taskID]
		if !ok {
			t.Fatalf("task %s has no execution result", taskID)
		}
		message := kernelRow(store.Db, "SELECT text FROM messages WHERE operation_id=? AND role='assistant' AND kind='chat'", operationID)
		node := kernelRow(store.Db, "SELECT status, output_operation FROM nodes WHERE task_id=? AND id='master'", taskID)
		if message == nil || kernelString(message["text"]) != taskID || node == nil || kernelString(node["status"]) != "succeeded" || kernelString(node["output_operation"]) != operationID {
			t.Fatalf("task %s result = message:%+v node:%+v", taskID, message, node)
		}
	}
}
