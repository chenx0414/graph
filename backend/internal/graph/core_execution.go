package graph

import (
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
	activeGraphs    map[string]bool
	running         int
	changed         chan struct{}
}
