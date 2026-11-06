package graph

import (
	"os"
	"strconv"
	"strings"
	"sync"
)

// graphDatabaseMu serializes the synchronous SQLite sections of the runtime.
// The TypeScript backend was single threaded: every database statement ran to
// completion between awaits. Go runs the adapter's real I/O in goroutines, so
// the statements that surround it are guarded here instead of interleaving
// inside another goroutine's transaction.
var graphDatabaseMu sync.Mutex

// ExecutionNodeRow is one node the executor can dispatch.
type ExecutionNodeRow struct {
	Id           string
	TaskId       string
	Spec         string
	InstanceId   *string
	Status       string
	Output       *string
	ActivationId string
}

// ExecutionGraph is one v2 graph the executor can drain.
type ExecutionGraph struct {
	TaskId string
	// Run drives the graph once. It reports whether the graph drained.
	Run func() bool
}

// ExecutionSystemContext is the host inventory the main Agent may read.
type ExecutionSystemContext struct {
	Resources         bool
	AgentCombinations bool
	SystemSummary     bool
}

// ExecutionExtras are the optional collaborators of the executor.
type ExecutionExtras struct {
	Fallback        *ActionAdapter
	Catalog         *Catalog
	Models          func() []ModelEntry
	Preferences     map[ModelGrade][]string
	PreferencesFunc func() map[ModelGrade][]string
	Git             *GitIntegration
	AutoWake        bool
	DispatchAllowed func() bool
	Graphs          func() []ExecutionGraph
	SystemContext   *ExecutionSystemContext
	Access          func() *ResolvedAccessPolicy
	Artifacts       *ArtifactWorkspace
	// CredentialRecovery renews an OAuth credential whose request was rejected.
	CredentialRecovery func(modelId string) error
}

// ExecutionDispatch counts the work one dispatch round started.
type ExecutionDispatch struct {
	Dispatched int `json:"dispatched"`
}

// Execution is the main execution state machine; graph agents run through the native lane.
type Execution struct {
	mu              sync.Mutex
	store           *TaskStore
	actions         map[string]ActionAdapter
	fallback        *ActionAdapter
	catalog         *Catalog
	models          func() []ModelEntry
	preferences     map[ModelGrade][]string
	preferencesFunc func() map[ModelGrade][]string
	git             *GitIntegration
	systemContext   *ExecutionSystemContext
	access          func() *ResolvedAccessPolicy
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

// sweepState reclaims the rows the daemon will not need again.
//
// The offline reclaim tool needs the daemon to be closed, so a daemon that
// runs for days keeps every event it ever wrote. The rules are the tool's:
// the newest events of every task stay, the older history of a task that has
// not moved for a day goes, and a task with work still in flight is left
// alone.
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

// The rules the daemon reclaims its own state with. They are the offline
// tool's rules, so the same state is kept whether the daemon is running or
// not. The environment may narrow them, which is how an operator who wants
// the state kept for longer says so.
const (
	stateDefaultSweepIntervalMs   = 3_600_000
	stateDefaultRetentionMinAgeMs = 86_400_000
	stateDefaultKeepEvents        = 200
	stateKeepCapabilitiesPerNode  = 1
	stateKeepHandoffsPerOperation = 1
)

// stateSweepIntervalMs is how often the daemon reclaims its own state.
func stateSweepIntervalMs() int64 {
	return stateEnvironmentMilliseconds("GRAPH_STATE_SWEEP_INTERVAL_MS", stateDefaultSweepIntervalMs)
}

// stateRetentionMinAgeMs is how long a task's history is kept.
func stateRetentionMinAgeMs() int64 {
	return stateEnvironmentMilliseconds("GRAPH_STATE_RETENTION_MIN_AGE_MS", stateDefaultRetentionMinAgeMs)
}

// stateKeepEventsPerTask is how many events of every task are kept.
func stateKeepEventsPerTask() int {
	value := stateEnvironmentMilliseconds("GRAPH_STATE_RETENTION_KEEP_EVENTS", stateDefaultKeepEvents)
	if value < 0 {
		return stateDefaultKeepEvents
	}
	return int(value)
}

// stateEnvironmentMilliseconds reads one millisecond setting from the environment.
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
