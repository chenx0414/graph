package graph


import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

func StartGraphDaemon(options DaemonOptions) *GraphDaemon {
	WidenProcessPath(nil)
	log := options.Log
	if log == nil {
		log = func(string) {}
	}
	SetSpawnGroupLedger(options.StateDir)
	for _, pgid := range ReapStaleProcesses(options.StateDir, defaultProcessJanitorOptions) {
		log(fmt.Sprintf("Reaped process %d left behind by an earlier run", pgid))
	}
	config := EmptyGraphConfig()
	if options.ConfigPath != nil {
		config = LoadGraphConfig(*options.ConfigPath)
	}
	var configStore *ConfigStore
	if options.ConfigPath != nil {
		configStore = OpenConfigStore(*options.ConfigPath).OwnStateDir(options.StateDir)
	}
	revokedPath := filepath.Join(options.StateDir, "revoked-secrets.json")
	revokedRefs, revocationFailure := readRevocations(revokedPath, config)
	if revocationFailure != "" {
		log(fmt.Sprintf("Revocation file unusable (%s); all configured credentials start revoked. Disable or restore a connection to repair it.", revocationFailure))
	}
	var live *LiveConfig
	liveSecrets := func() map[string]string { return map[string]string{} }
	liveRevoked := func() []string { return nil }
	usage := CreateUsageService(UsageServiceOptions{
		Env:  options.Env,
		Home: options.Env["HOME"],
		LoadConfig: func() (GraphConfig, map[string]string) {
			if configStore == nil {
				return EmptyGraphConfig(), map[string]string{}
			}
			merged := map[string]string{}
			for key, value := range options.Env {
				merged[key] = value
			}
			for key, value := range liveSecrets() {
				merged[key] = value
			}
			for _, ref := range liveRevoked() {
				delete(merged, ref)
			}
			snapshot := configStore.Snapshot()
			return snapshot.Config, merged
		},
	})
	imported := map[string]string{}
	func() {
		defer func() { _ = recover() }()
		imported = usage.SecretValues()
	}()
	revision := 0
	if configStore != nil {
		revision = configStore.Revision()
	}
	live = CreateLiveConfig(LiveConfigOptions{
		Env: options.Env, Log: log,
		Initial: LiveConfigInitial{Config: config, Revision: revision},
		Secrets: imported, Revoked: revokedRefs,
	})
	liveSecrets = live.Secrets
	liveRevoked = live.Revoked
	entries := live.Entries()
	conflict := live.Snapshot().Conflict
	if !options.Dynamic {
		if options.Mode == "execute" && len(entries) == 0 {
			Raise("models_missing", "Execution mode requires a config with at least one model entry; start view-only or configure a model first")
		}
		if conflict != "" && options.Mode == "execute" {
			Raise("invalid_config", conflict)
		}
		if options.Mode == "execute" && len(entries) > 0 && len(live.ResolvedCredentialIDs()) == 0 {
			Raise("credentials_missing", "Execution mode requires at least one configured credential; set: "+strings.Join(missingSecrets(config, entries, options.Env), ", "))
		}
	}
	if conflict != "" {
		log(fmt.Sprintf("Config problem (%s); model dispatch stays disabled.", conflict))
	}
	missing := missingSecrets(config, entries, options.Env)
	if len(entries) > 0 && len(missing) > 0 {
		if live.Enabled() {
			log(fmt.Sprintf("Credentials not configured (%s); those models stay disabled.", strings.Join(missing, ", ")))
		} else {
			log(fmt.Sprintf("Credentials not configured (%s); model dispatch stays disabled.", strings.Join(missing, ", ")))
		}
	}
	scheduler := CreateModelScheduler()
	modelRuntime := NewModelRuntime()
	syncProviders := func() {
		daemonSyncProviders(options, live, modelRuntime)
	}
	capabilitySecretValues := func() map[string]string { return daemonCapabilitySecrets(options, live) }
	syncProviders()
	if err := os.MkdirAll(options.StateDir, 0o700); err != nil {
		panic(err)
	}
	stateDir, err := filepath.EvalSymlinks(options.StateDir)
	if err != nil {
		stateDir = options.StateDir
	}
	appToken := graphUUID()
	if err := os.WriteFile(filepath.Join(stateDir, "app-token"), []byte(appToken+"\n"), 0o600); err != nil {
		panic(err)
	}
	rsiRoot := ResolveRsiRoot(options.Env, cliCwd())
	rsi := OpenRsiService(RsiServiceOptions{Root: rsiRoot, StateDir: stateDir})
	runningSource := ReadSourceIdentity(ApplicationRoot)
	presetsDir := options.PresetsDir
	if presetsDir == "" {
		presetsDir = presetsRoot()
	}
	userHome := options.GraphHome
	if userHome == "" {
		userHome = GraphHome(options.Env)
	}
	warmRuntimeAssets()
	bootstrap := LoadPresetBootstrap(presetsDir, log)
	agentContext := OpenAgentContextLibrary(filepath.Join(userHome, "prompts"))
	ensureAgentContext(agentContext)
	testConnection := func(modelID string) map[string]any {
		return daemonTestConnection(live, modelID)
	}
	var server *GraphHost
	var configWatch *ConfigWatch
	var secrets *SecretPersist
	var configQueue sync.Mutex
	presetsAvailable := false
	definitionsPublished := false
	catalogReady := false
	publishDefinitions := func() {
		if presetsAvailable || definitionsPublished || !live.Enabled() {
			return
		}
		definitionsPublished = true
		catalog := runtimeCatalog(server)
		if catalog == nil {
			return
		}
		catalog.PublishDefinition("master", DefinitionSpec{})
		catalog.PublishDefinition("coder", DefinitionSpec{})
		catalog.PublishDefinition("reviewer", DefinitionSpec{Review: true})
	}
	currentMasterDefinitionVersion := func() string {
		return daemonMasterDefinitionVersion(server, bootstrap.Prompts["main"] != "")
	}
	serialized := func(action func() ApplyConfigResult) ApplyConfigResult {
		configQueue.Lock()
		defer configQueue.Unlock()
		return action()
	}
	statusCounts := func() ApplyConfigResult {
		status := live.Status()
		return ApplyConfigResult{
			Revision: live.Revision(), EffectiveRevision: live.Revision(), Applied: true,
			Configured: live.Enabled(), ModelCount: len(live.Entries()), EnabledModelCount: status.EnabledModelCount,
		}
	}
	activate := func() {
		if options.Mode != "execute" && !options.Dynamic {
			return
		}
		server.StartDrive()
		server.Runtime.Host.RecoverMasters()
	}
	approve := func(candidate GraphConfig, revision int) ApplyResult {
		verdict := live.Check(candidate, revision)
		if !verdict.Applied {
			return verdict
		}
		if err := portRecover(func() { server.Runtime.Host.CheckProjects(candidate.Projects) }); err != nil {
			return ApplyResult{Applied: false, Reason: liveReason(err.Error())}
		}
		return ApplyResult{Applied: true}
	}
	applyNow := func(document any, expectedRevision int) ApplyConfigResult {
		if configStore == nil {
			Raise("invalid_config", "The daemon was started without a configuration file")
		}
		saved := configStore.Save(document, expectedRevision, options.Env, func(candidate GraphConfig, revision int) ConfigApproval {
			verdict := approve(candidate, revision)
			return ConfigApproval{Applied: verdict.Applied, Reason: verdict.Reason}
		})
		if !saved.Applied {
			result := statusCounts()
			result.Revision = saved.Revision
			result.Applied = false
			result.Reason = saved.Reason
			return result
		}
		result := live.Apply(saved.Config, saved.Revision)
		if result.Applied {
			server.Runtime.ApplyExecutionLimits(saved.Config.Limits)
			syncProviders()
			server.Runtime.Host.SyncProjects()
			scheduler.Wake()
			publishDefinitions()
			activate()
		}
		out := statusCounts()
		out.Revision = saved.Revision
		out.Applied = result.Applied
		if !result.Applied {
			out.Reason = result.Reason
		}
		return out
	}
	persistRevoked := func(refs []string) error {
		return writeRevocations(revokedPath, refs)
	}
	pushNow := func(ref string, value *string, persisted bool) ApplyConfigResult {
		if !secretRefPattern.MatchString(ref) {
			Raise("invalid_input", "secretRef must be an environment variable name")
		}
		if value != nil && (strings.TrimSpace(*value) == "" || len(*value) > 8192) {
			Raise("invalid_input", "A nonempty bounded secret value is required")
		}
		var acknowledged *string
		if value != nil {
			trimmed := strings.TrimSpace(*value)
			acknowledged = &trimmed
		}
		if persisted {
			var pending *SecretPersistRequest
			for _, request := range secrets.List() {
				if request.Ref == ref {
					copied := request
					pending = &copied
					break
				}
			}
			var current *string
			hasCurrent := stringIn(live.Revoked(), ref)
			if !hasCurrent {
				if stored, ok := live.Secrets()[ref]; ok {
					copied := stored
					current = &copied
					hasCurrent = true
				}
			}
			stale := (pending != nil && !sameSecret(pending.Value, acknowledged)) || (pending == nil && hasCurrent && !sameSecret(current, acknowledged))
			if stale {
				if pending == nil && hasCurrent {
					secrets.Mark(ref, current)
				}
				result := statusCounts()
				result.Applied = false
				result.Reason = liveReason("持久化确认已过期，等待桌面同步最新值")
				return result
			}
		}
		revoking := value == nil || strings.TrimSpace(*value) == ""
		previous := live.Revoked()
		next := append([]string{}, previous...)
		if revoking {
			next = append(next, ref)
		} else {
			filtered := []string{}
			for _, item := range previous {
				if item != ref {
					filtered = append(filtered, item)
				}
			}
			next = filtered
		}
		same := sameStrings(previous, next)
		if !same {
			if err := persistRevoked(next); err != nil {
				result := statusCounts()
				result.Applied = false
				result.Reason = liveReason(fmt.Sprintf("撤销未能持久化（%s）；连接保持原状态", err.Error()))
				return result
			}
		}
		var pushed *string
		if !revoking {
			trimmed := strings.TrimSpace(*value)
			pushed = &trimmed
		}
		result := live.PushSecret(ref, pushed)
		if !result.Applied && !same {
			_ = persistRevoked(previous)
		}
		if persisted {
			secrets.Confirmed(ref)
		} else if result.Applied {
			secrets.Mark(ref, pushed)
		}
		if result.Applied {
			syncProviders()
			scheduler.Wake()
			publishDefinitions()
			activate()
		}
		out := statusCounts()
		out.Applied = result.Applied
		if !result.Applied {
			out.Reason = result.Reason
		}
		return out
	}
	refreshNow := func(expectedRevision int) ApplyConfigResult {
		return daemonRefreshPrices(options, config, configStore != nil, applyNow, expectedRevision)
	}
	secrets = CreateSecretPersist()
	port := options.Port
	autoDrive := options.Mode == "execute" || options.Dynamic
	systemSummary := func() any {
		return daemonSystemSummary(live, userHome, agentContext, server, usage)
	}
	server = OpenGraphServer(GraphServerOptions{
		Ready:    func() bool { return catalogReady },
		StateDir: stateDir, Projects: config.Projects, Port: &port, AutoDrive: &autoDrive,
		Codemode:      config.Codemode,
		SystemContext: &TaskRuntimeSystemContext{SystemSummary: systemSummary},
		Limits: &TaskRuntimeLimits{
			AgentExecutions: config.Limits.AgentExecutions, ProgramExecutions: config.Limits.ProgramExecutions,
			MaxAgents: config.Limits.MaxAgents, SpawnDepth: config.Limits.SpawnDepth, ChildrenPerAgent: config.Limits.ChildrenPerAgent,
		},
		Models: &TaskRuntimeModels{
			Entries: live.Entries(), ModelRuntime: modelRuntime, ModelScheduler: scheduler,
			CredentialFor: func(entry ConfiguredModel) *ResolvedCredential { return live.CredentialFor(entry) },
		},
		Magpie: NewMagpieModels(),
		Live: &TaskRuntimeLive{
			Revision: live.Revision, Config: live.Config, Entries: live.Entries,
			CredentialFor: func(entry ConfiguredModel) *ResolvedCredential { return live.CredentialFor(entry) },
			MasterModel:   live.MasterModel, Projects: live.Projects,
		},
		Master: &TaskRuntimeMaster{
			Action: "master", Model: live.MasterModel, DefinitionVersion: currentMasterDefinitionVersion,
		},
		Catalog: &TaskRuntimeCatalog{
			CapabilityRoot: filepath.Join(userHome, "capabilities"), RecipesPath: filepath.Join(userHome, "agent-combinations.json"),
			BootstrapPrompts: bootstrap.Prompts, BootstrapToolPrompt: bootstrap.ToolPrompt,
		},
		Usage: usage, Rsi: rsi, AgentContext: agentContext,
		StartupInfo: func() StartupInfo {
			status := live.Status()
			revision := live.Revision()
			source := runningSource
			info := StartupInfo{
				Mode: options.Mode, Configured: live.Enabled(), ModelCount: len(live.Entries()),
				EnabledModelCount: status.EnabledModelCount, EffectiveRevision: &revision, Source: &source,
			}
			if len(status.LimitAliases) > 0 {
				info.LimitAliases = status.LimitAliases
			}
			return info
		},
		ConfigStore: configStore, ConfigEnv: envPointers(mergeEnv(options.Env, imported)),
		ConfigTest: func(modelID string) any { return testConnection(modelID) },
		AppServices: &AppServices{
			ApplyConfig: func(document any, expected int) any {
				return serialized(func() ApplyConfigResult { return applyNow(document, expected) })
			},
			PushSecret: func(ref string, value *string, persisted *bool) any {
				flag := persisted != nil && *persisted
				return serialized(func() ApplyConfigResult { return pushNow(ref, value, flag) })
			},
			PendingSecretRequests: secrets.List,
			ConfigWatch: func() *ConfigWatchReport {
				if configWatch == nil {
					return nil
				}
				report := configWatch.Report()
				return &report
			},
			AppToken: appToken,
			RefreshPrices: func(expected int) any {
				return serialized(func() ApplyConfigResult { return refreshNow(expected) })
			},
			CapabilityConfig: &struct{ SecretValues func() map[string]string }{SecretValues: capabilitySecretValues},
			Rsi: &AppRsiService{
				Status: func(compare bool) any { return rsi.Status(compare) },
				Ack: func(id string) any {
					return server.Runtime.Host.AckRsiRestart(id)
				},
			},
			Snapshot: func() any { return statusCounts() },
		},
	})
	if rsi != nil && server.Runtime != nil {
		rsi.reload = &RsiReloadHooks{
			Pause: func(store *TaskStore, excludeTaskID string) []string {
				return server.Runtime.PauseForReload(store, excludeTaskID)
			},
			Resume: func(store *TaskStore, ids []string) []string { return server.Runtime.ResumeAfterReload(store, ids) },
		}
	}
	presetResult := PublishBootstrap(runtimeCatalog(server), bootstrap, log)
	presetsAvailable = presetResult.Available
	publishDefinitions()
	catalogReady = true
	ensureMainRecipe(runtimeCatalog(server), bootstrap, log)
	if presetsAvailable {
		log(fmt.Sprintf("Bootstrap: %d definitions ready%s; capabilities: %s.", len(presetResult.Installed),
			failedDefinitionsSuffix(presetResult.Failed), filepath.Join(userHome, "capabilities")))
	}
	if options.ConfigPath != nil {
		configWatch = CreateConfigWatch(ConfigWatchOptions{
			Path: *options.ConfigPath, Log: log,
			Parse: func(text string) ConfigWatchParsed {
				var raw map[string]any
				if err := json.Unmarshal([]byte(text), &raw); err != nil {
					panic(err)
				}
				parsed := ParseGraphConfig(raw, *options.ConfigPath)
				var revision *int64
				if number, ok := raw["revision"].(float64); ok {
					value := int64(number)
					revision = &value
				}
				return ConfigWatchParsed{Config: parsed, Revision: revision}
			},
			Apply: func(candidate GraphConfig, revision int) ApplyResult {
				effective := revision
				if live.Revision() > effective {
					effective = live.Revision()
				}
				verdict := approve(candidate, effective)
				if !verdict.Applied {
					return verdict
				}
				result := live.Apply(candidate, effective)
				if result.Applied {
					go func() {
						if err := portRecover(func() {
							syncProviders()
							server.Runtime.Host.SyncProjects()
							scheduler.Wake()
							publishDefinitions()
							activate()
						}); err != nil {
							log("Configuration applied but activation failed: " + err.Error())
						}
					}()
				}
				return result
			},
		})
	}
	status := live.Status()
	daemon := &GraphDaemon{
		URL: server.Url, StateDir: stateDir, ConfigPath: config.Path, Mode: options.Mode,
		Configured: live.Enabled(), ModelCount: len(live.Entries()), EnabledModelCount: status.EnabledModelCount,
		AppToken: appToken, server: server, watch: configWatch,
	}
	daemon.applyConfig = func(document any, expected int) ApplyConfigResult {
		return serialized(func() ApplyConfigResult { return applyNow(document, expected) })
	}
	daemon.pushSecret = func(ref string, value *string, persisted ...bool) ApplyConfigResult {
		flag := false
		if len(persisted) > 0 {
			flag = persisted[0]
		}
		return serialized(func() ApplyConfigResult { return pushNow(ref, value, flag) })
	}
	daemon.refreshPrices = func(expected int) ApplyConfigResult {
		return serialized(func() ApplyConfigResult { return refreshNow(expected) })
	}
	if config.Path != nil {
		daemon.ConfigPath = config.Path
	}
	return daemon
}
