package graph

import (
	"os"
	"path/filepath"
	"strings"
)

func OpenTaskRuntime(options GraphServerOptions) *TaskRuntime {
	runtime := &TaskRuntime{options: options, stateDir: options.StateDir, projects: options.Projects, taskSetups: NewTaskSetupLedger()}
	if options.AutoDrive != nil {
		runtime.autoWake = *options.AutoDrive
	}
	if err := os.MkdirAll(options.StateDir, 0o700); err != nil {
		panic(err)
	}
	resolved, err := filepath.EvalSymlinks(options.StateDir)
	if err != nil {
		panic(err)
	}
	runtime.stateDir = resolved

	runtime.models = options.Models
	if runtime.models == nil {
		runtime.models = &TaskRuntimeModels{}
	}
	runtime.magpie = options.Magpie
	runtime.live = options.Live
	if runtime.live == nil {
		runtime.live = &TaskRuntimeLive{}
	}
	runtime.master = options.Master
	if runtime.master == nil {
		runtime.master = &TaskRuntimeMaster{}
	}
	runtime.catalogOpt = options.Catalog
	if runtime.catalogOpt == nil {
		runtime.catalogOpt = &TaskRuntimeCatalog{}
	}
	runtime.limits = options.Limits
	if runtime.limits == nil {
		runtime.limits = &TaskRuntimeLimits{}
	}
	runtime.agentCtx = options.AgentContext
	runtime.rsi = options.Rsi
	runtime.systemCtx = options.SystemContext

	releaseOwner := AcquireOwner(filepath.Join(runtime.stateDir, "owner.sqlite"))
	store, err := OpenSQLite(filepath.Join(runtime.stateDir, "tasks.sqlite"))
	if err != nil {
		releaseOwner()
		panic(err)
	}
	runtime.store = NewTaskStore(store, filepath.Join(runtime.stateDir, "tasks.sqlite"))
	defer func() {
		if recovered := recover(); recovered != nil {
			runtime.store.Close()
			releaseOwner()
			panic(recovered)
		}
	}()

	runtime.kernel = NewKernelStore(runtime.store)
	RetireLegacyGraphs(runtime.store)
	interruptedNodes := RecoverKernelExecutions(runtime.kernel)
	runtime.ApplyExecutionLimits(LimitsConfig{
		AgentExecutions:   runtime.limits.AgentExecutions,
		ProgramExecutions: runtime.limits.ProgramExecutions,
	})
	runtime.store.RebuildExecutionSlots()

	runtime.store.Transaction(func() any {
		for _, project := range runtime.configuredProjects() {
			if strings.TrimSpace(project.Id) == "" || strings.TrimSpace(project.Root) == "" {
				Raise("invalid_input", "Project identity, root and grants must be nonempty strings")
			}
			root, err := filepath.Abs(project.Root)
			if err != nil {
				root = project.Root
			}
			grants := taskRuntimeGrants(project.Grants)
			previous := kernelRow(runtime.store.Db, "SELECT root,grants FROM projects WHERE id=?", project.Id)
			if previous != nil && (kernelString(previous["root"]) != root || (project.Grants != nil && kernelString(previous["grants"]) != grants)) {
				Raise("project_conflict", "Persisted project root and base grants cannot change during restore")
			}
			runtime.store.KeepProject(project.Id, root, grants)
		}
		return nil
	})

	runtime.catalog = NewCatalog(runtime.store, CatalogOptions{
		CapabilityRoot: runtime.catalogOpt.CapabilityRoot,
		RecipesPath:    runtime.catalogOpt.RecipesPath,
		Projects:       func() []ProjectConfig { return runtime.configuredProjects() },
	})
	runtime.catalog.Refresh()
	runtime.git = NewGitIntegration(runtime.store, runtime.stateDir)
	runtime.artifacts = NewArtifactWorkspace(runtime.store, filepath.Join(runtime.stateDir, "artifact-workspace"))

	runtime.scheduler = CreateModelScheduler()
	if runtime.models != nil && runtime.models.ModelScheduler != nil {
		runtime.scheduler = runtime.models.ModelScheduler
	}
	if runtime.models != nil {
		runtime.store.Transaction(func() any {
			for _, entry := range runtime.models.Entries {
				kernelExec(runtime.store.Db, "INSERT OR REPLACE INTO models VALUES(?,?)", entry.Id, CanonicalJSON(entry))
			}
			return nil
		})
	}
	if runtime.live != nil {
		runtime.store.Transaction(func() any {
			for _, entry := range runtime.live.Entries() {
				kernelExec(runtime.store.Db, "INSERT OR REPLACE INTO models VALUES(?,?)", entry.Id, CanonicalJSON(entry))
			}
			return nil
		})
	}

	fallback := runtime.fallbackAdapter()
	runtime.execution = NewExecution(runtime.store, map[string]ActionAdapter{}, ExecutionExtras{
		Fallback:        fallback,
		Catalog:         runtime.catalog,
		Models:          runtime.liveEntries,
		Git:             runtime.git,
		AutoWake:        runtime.autoWake,
		DispatchAllowed: runtime.dispatchAllowed,
		Graphs:          runtime.graphs,
		SystemContext:   runtime.executionSystemContext(),
		Artifacts:       runtime.artifacts,
		CredentialRecovery: func(request CredentialRecoveryRequest) bool {
			if runtime.options.OnCredentialRejected == nil {
				return false
			}
			return runtime.options.OnCredentialRejected(request)
		},
	})
	runtime.bootstrapPigRecovery(interruptedNodes)
	runtime.abortStalledMasterTurns()
	runtime.dispatchQueuedMasterMessages()
	SetDeferredDeliveryHook(func(conversationId, requestId string) bool {
		return kernelString(runtime.Conversations().Steer(conversationId, requestId)["state"]) == "steered"
	})
	runtime.Host = &TaskRuntimeHost{runtime: runtime}
	runtime.RecoverMasters()
	runtime.markInterruptedGraphPreparations()
	if runtime.autoWake {
		go runtime.recoverWorkGraphs()
		go runtime.recoverTransferredGraphPreparations()
	}
	return runtime
}

func (runtime *TaskRuntime) ApplyExecutionLimits(limits LimitsConfig) {
	if runtime == nil || runtime.store == nil {
		return
	}
	runtime.store.SetExecutionLimits(limits.AgentExecutions, limits.ProgramExecutions)
}
