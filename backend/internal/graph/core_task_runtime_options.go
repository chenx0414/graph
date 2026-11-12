package graph

import (
	"sync"
)

type TaskRuntimeModels struct {
	Entries        []ConfiguredModel
	APIKey         string
	ModelRuntime   *ModelRuntime
	ModelScheduler *ModelScheduler
	CredentialFor  func(ConfiguredModel) *ResolvedCredential
}

type TaskRuntimeLive struct {
	Revision            func() int
	Config              func() GraphConfig
	Entries             func() []ConfiguredModel
	CredentialFor       func(ConfiguredModel) *ResolvedCredential
	MasterModel         func() string
	Projects            func() []ProjectConfig
}

type TaskRuntimeMaster struct {
	Action            string
	Model             func() string
	DefinitionVersion func() string
}

type TaskRuntimeCatalog struct {
	CapabilityRoot      string
	RecipesPath         string
	BootstrapPrompts    map[string]string
	BootstrapToolPrompt string
}

type TaskRuntimeLimits struct {
	AgentExecutions   int
	ProgramExecutions int
}

type TaskRuntimeSystemContext struct {
	SystemSummary func() any
}

type TaskRuntimeHost struct {
	runtime *TaskRuntime
}

func (h *TaskRuntimeHost) Pump() {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.pump()
}

func (h *TaskRuntimeHost) AckRsiRestart(id string) any {
	if h == nil || h.runtime == nil {
		Raise("rsi_unavailable", "RSI is unavailable")
	}
	return h.runtime.AckRsiRestart(id)
}

func (h *TaskRuntimeHost) RunReady() ExecutionDispatch {
	if h == nil || h.runtime == nil {
		return ExecutionDispatch{}
	}
	return h.runtime.RunReady()
}

func (h *TaskRuntimeHost) CheckProjects(projects []ProjectConfig) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.CheckProjects(projects)
}

func (h *TaskRuntimeHost) SyncProjects() {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.SyncProjects()
}

func (h *TaskRuntimeHost) Drive() ExecutionDispatch {
	if h == nil || h.runtime == nil {
		return ExecutionDispatch{}
	}
	return h.runtime.Drive()
}

func (h *TaskRuntimeHost) Report(id string, generation int, result OperationResult) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.Report(id, generation, result)
}

func (h *TaskRuntimeHost) Reconcile(id string) {
	if h == nil || h.runtime == nil {
		return
	}
	h.runtime.Reconcile(id)
}

func (h *TaskRuntimeHost) RecoverMasters() int {
	if h == nil || h.runtime == nil {
		return 0
	}
	return h.runtime.RecoverMasters()
}

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
	agentCtx   *AgentContextLibrary
	systemCtx  *TaskRuntimeSystemContext
	rsi        *RsiService
	autoWake   bool
	taskSetups *TaskSetupLedger
	Host       *TaskRuntimeHost
	graphLane       *GraphLane
	laneTokenBudget *TokenBudget
}
