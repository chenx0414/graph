package graph

import (
	"sync"
)

// TaskRuntimeModels is the static model configuration of one runtime.
type TaskRuntimeModels struct {
	Entries        []ConfiguredModel
	APIKey         string
	ModelRuntime   *ModelRuntime
	ModelScheduler *ModelScheduler
	CredentialFor  func(ConfiguredModel) *ResolvedCredential
}

// TaskRuntimeLive is the hot-reloadable configuration view of one runtime.
type TaskRuntimeLive struct {
	Revision            func() int
	Config              func() GraphConfig
	Entries             func() []ConfiguredModel
	CredentialFor       func(ConfiguredModel) *ResolvedCredential
	MasterModel         func() string
	Projects            func() []ProjectConfig
}

// TaskRuntimeMaster is the master Agent binding of one runtime.
type TaskRuntimeMaster struct {
	Action            string
	Model             func() string
	DefinitionVersion func() string
}

// TaskRuntimeCatalog is the capability library configuration of one runtime.
type TaskRuntimeCatalog struct {
	CapabilityRoot      string
	RecipesPath         string
	BootstrapPrompts    map[string]string
	BootstrapToolPrompt string
}

// TaskRuntimeLimits are the default budget limits of one runtime.
type TaskRuntimeLimits struct {
}

// TaskRuntimeSystemContext is the read-only host inventory of one runtime.
type TaskRuntimeSystemContext struct {
	SystemSummary func() any
}

// TaskRuntimeHost is the host side of one runtime.
type TaskRuntimeHost struct {
	runtime *TaskRuntime
}

// Pump dispatches the work that is ready.
func (h *TaskRuntimeHost) Pump() {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.pump()
}

// AckRsiRestart clears a pending RSI restart and wakes the dispatch loop.
func (h *TaskRuntimeHost) AckRsiRestart(id string) any {
	if h == nil || h.runtime == nil {
		Raise("rsi_unavailable", "RSI is unavailable")
	}
	return h.runtime.AckRsiRestart(id)
}

// RunReady dispatches every operation that is ready.
func (h *TaskRuntimeHost) RunReady() ExecutionDispatch {
	if h == nil || h.runtime == nil {
		return ExecutionDispatch{}
	}
	return h.runtime.RunReady()
}

// CheckProjects is the read-only candidate check: a hot config that moves the
// root of a project with tasks in flight must be rejected.
func (h *TaskRuntimeHost) CheckProjects(projects []ProjectConfig) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.CheckProjects(projects)
}

// SyncProjects registers hot-added projects and rejects root moves while
// tasks are in flight.
func (h *TaskRuntimeHost) SyncProjects() {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.SyncProjects()
}

// Drive runs one dispatch round.
func (h *TaskRuntimeHost) Drive() ExecutionDispatch {
	if h == nil || h.runtime == nil {
		return ExecutionDispatch{}
	}
	return h.runtime.Drive()
}

// Report hands an operation result back to the runtime.
func (h *TaskRuntimeHost) Report(id string, generation int, result OperationResult) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.Report(id, generation, result)
}

// Reconcile re-reads the state of one operation.
func (h *TaskRuntimeHost) Reconcile(id string) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.Reconcile(id)
}

// RecoverMasters creates master nodes for pending tasks after a hot
// configuration apply.
func (h *TaskRuntimeHost) RecoverMasters() int {
	if h == nil || h.runtime == nil {
		return 0
	}
	return h.runtime.RecoverMasters()
}

// TaskRuntime is the backend runtime: tasks, conversations, graphs and the host loop.
type TaskRuntime struct {
	options    GraphServerOptions
	mu         sync.Mutex
	store      *TaskStore
	kernel     *KernelStore
	catalog    *Catalog
	git        *GitIntegration
	artifacts  *ArtifactWorkspace
	execution  *Execution
	scheduler  *ModelScheduler
	closed     bool
	stateDir   string
	projects   []ProjectConfig
	live       *TaskRuntimeLive
	models     *TaskRuntimeModels
	master     *TaskRuntimeMaster
	catalogOpt *TaskRuntimeCatalog
	limits     *TaskRuntimeLimits
	access     func() AccessPolicy
	agentCtx   *AgentContextLibrary
	systemCtx  *TaskRuntimeSystemContext
	rsi        *RsiService
	autoWake   bool
	taskSetups *TaskSetupLedger
	Host       *TaskRuntimeHost
	// graphLane is the resident v2 lane; laneTokenBudget is the live budget it
	// runs its nodes under.
	graphLane       *GraphLane
	laneTokenBudget *TokenBudget
}
