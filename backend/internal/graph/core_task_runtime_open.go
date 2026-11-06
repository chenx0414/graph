package graph

import (
	"os"
	"path/filepath"
	"strings"
)

// OpenTaskRuntime opens the backend runtime over one state directory.
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

	// The option bags stay non-nil so a runtime opened without one still has
	// an empty configuration to read.
	runtime.models = options.Models
	if runtime.models == nil {
		runtime.models = &TaskRuntimeModels{}
	}
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
	runtime.access = options.Access
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

	if runtime.limits != nil && runtime.limits.DefaultBudgetTokens != nil {
		budget := runtime.limits.DefaultBudgetTokens()
		if budget != nil && *budget <= 0 {
			Raise("invalid_input", "limits.defaultBudgetTokens must be a positive integer or null")
		}
	}
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
		PreferencesFunc: runtime.livePreferences,
		Git:             runtime.git,
		AutoWake:        runtime.autoWake,
		DispatchAllowed: runtime.dispatchAllowed,
		Graphs:          runtime.graphs,
		SystemContext:   runtime.executionSystemContext(),
		Access:          runtime.resolvedAccessPolicy,
		Artifacts:       runtime.artifacts,
		CredentialRecovery: func(request CredentialRecoveryRequest) bool {
			if runtime.options.OnCredentialRejected == nil {
				return false
			}
			return runtime.options.OnCredentialRejected(request)
		},
	})
	// The recovery bootstrap belongs to the kernel that owns the durable
	// conversations. The PiG kernel keeps them in this process, so it
	// recovers on its own: the kernel's own receipts settle the turns it
	// finished, and the turns it never sent are sent again.
	runtime.bootstrapPigRecovery(interruptedNodes)
	// A restart that cut through a tool leaves work the kernel will not run
	// again; it must not hold the conversation, or no later turn can start.
	runtime.abortStalledMasterTurns()
	// A message queued behind that work is still the user's request: release
	// the questions it would have released and let the master run it.
	runtime.dispatchQueuedMasterMessages()
	// The state the last run left behind is reclaimed before this one
	// starts: a daemon that only reclaimed while it was running would let the
	// state of every run before it grow for ever.
	runtime.execution.sweepState()
	runtime.Host = &TaskRuntimeHost{runtime: runtime}
	// Tasks and conversations created while dispatch was disabled carry no
	// master node. Once a master binding exists they get one and become
	// driveable again; queued conversation messages stay pending until then.
	// The same scan runs after a hot configuration apply.
	runtime.RecoverMasters()
	runtime.markInterruptedGraphPreparations()
	if runtime.autoWake {
		go runtime.recoverWorkGraphs()
		go runtime.recoverTransferredGraphPreparations()
	}
	return runtime
}
