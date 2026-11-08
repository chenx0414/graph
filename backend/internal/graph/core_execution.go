package graph

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

var graphDatabaseMu sync.Mutex

type ExecutionNodeRow struct {
	Id           string
	TaskId       string
	Spec         string
	InstanceId   *string
	Status       string
	Output       *string
	ActivationId string
}

type ExecutionGraph struct {
	TaskId string
	Run func() bool
}

type ExecutionSystemContext struct {
	Resources         bool
	AgentCombinations bool
	SystemSummary     bool
}

type ExecutionExtras struct {
	Fallback        *ActionAdapter
	Catalog         *Catalog
	Models          func() []ModelEntry
	Git             *GitIntegration
	AutoWake        bool
	DispatchAllowed func() bool
	Graphs          func() []ExecutionGraph
	SystemContext   *ExecutionSystemContext
	Artifacts       *ArtifactWorkspace
	CredentialRecovery func(CredentialRecoveryRequest) bool
}

type ExecutionDispatch struct {
	Dispatched int `json:"dispatched"`
}

type Execution struct {
	mu              sync.Mutex
	store           *TaskStore
	actions         map[string]ActionAdapter
	fallback        *ActionAdapter
	catalog         *Catalog
	models          func() []ModelEntry
	git             *GitIntegration
	systemContext   *ExecutionSystemContext
	dispatchAllowed func() bool
	graphs          func() []ExecutionGraph
	autoWake        bool
	generation      int
	lifecycle       *OperationLifecycle
	unsubscribe     func()
	pumping         bool
	stopping        bool
	driveActive     int
	sweptAt         int64
	sweptStateAt    int64
	activeGraphs    map[string]bool
	running         int
	changed         chan struct{}
}

func (e *Execution) sweepState() {
	now := NowMillis()
	e.mu.Lock()
	swept := e.sweptStateAt
	e.mu.Unlock()
	if now-swept < stateSweepIntervalMs() {
		return
	}
	e.mu.Lock()
	e.sweptStateAt = now
	e.mu.Unlock()
	func() {
		defer func() { _ = recover() }()
		e.store.ApplyRetention(RetentionOptions{
			Now:                      now,
			KeepEventsPerTask:        stateKeepEventsPerTask(),
			KeepCapabilitiesPerNode:  stateKeepCapabilitiesPerNode,
			KeepHandoffsPerOperation: stateKeepHandoffsPerOperation,
			MinAgeMs:                 stateRetentionMinAgeMs(),
		})
	}()
}

const (
	stateDefaultSweepIntervalMs   = 3_600_000
	stateDefaultRetentionMinAgeMs = 86_400_000
	stateDefaultKeepEvents        = 200
	stateKeepCapabilitiesPerNode  = 1
	stateKeepHandoffsPerOperation = 1
)

func stateSweepIntervalMs() int64 {
	return stateEnvironmentMilliseconds("GRAPH_STATE_SWEEP_INTERVAL_MS", stateDefaultSweepIntervalMs)
}

func stateRetentionMinAgeMs() int64 {
	return stateEnvironmentMilliseconds("GRAPH_STATE_RETENTION_MIN_AGE_MS", stateDefaultRetentionMinAgeMs)
}

func stateKeepEventsPerTask() int {
	value := stateEnvironmentMilliseconds("GRAPH_STATE_RETENTION_KEEP_EVENTS", stateDefaultKeepEvents)
	if value < 0 {
		return stateDefaultKeepEvents
	}
	return int(value)
}

func stateEnvironmentMilliseconds(name string, fallback int64) int64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || value < 0 {
		return fallback
	}
	return value
}
