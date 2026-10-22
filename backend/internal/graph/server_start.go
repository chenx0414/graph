package graph

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// DaemonOptions is the console process configuration.
type DaemonOptions struct {
	ConfigPath  *string
	StateDir    string
	WebDir      string
	GraphHome   string
	Port        int
	Mode        string
	Env         map[string]string
	Log         func(string)
	Dynamic     bool
	PresetsDir  string
	PriceVerify func(PriceSnapshot) bool
}

// ApplyConfigResult is one config or secret apply.
type ApplyConfigResult struct {
	Revision          int                  `json:"revision"`
	EffectiveRevision int                  `json:"effectiveRevision"`
	Applied           bool                 `json:"applied"`
	Reason            *string              `json:"reason"`
	Configured        bool                 `json:"configured"`
	ModelCount        int                  `json:"modelCount"`
	EnabledModelCount int                  `json:"enabledModelCount"`
	Results           []PriceRefreshResult `json:"results"`
}

// GraphDaemon is the running console.
type GraphDaemon struct {
	URL               string
	StateDir          string
	WebDir            string
	ConfigPath        *string
	Mode              string
	Configured        bool
	ModelCount        int
	EnabledModelCount int
	AppToken          string
	server            *GraphHost
	watch             *ConfigWatch
	applyConfig       func(any, int) ApplyConfigResult
	pushSecret        func(string, *string, ...bool) ApplyConfigResult
	refreshPrices     func(int) ApplyConfigResult
}

// ApplyConfig validates and activates one document.
func (daemon *GraphDaemon) ApplyConfig(document any, expectedRevision int) ApplyConfigResult {
	return daemon.applyConfig(document, expectedRevision)
}

// PushSecret applies one APP-supplied secret. A nil value revokes it.
func (daemon *GraphDaemon) PushSecret(ref string, value *string, persisted ...bool) ApplyConfigResult {
	return daemon.pushSecret(ref, value, persisted...)
}

// RefreshPrices re-verifies archived prices and activates the result.
func (daemon *GraphDaemon) RefreshPrices(expectedRevision int) ApplyConfigResult {
	return daemon.refreshPrices(expectedRevision)
}

// Close stops the HTTP server and the runtime it owns.
func (daemon *GraphDaemon) Close() {
	if daemon.watch != nil {
		daemon.watch.Stop()
	}
	if daemon.server != nil {
		daemon.server.Close()
	}
}

type providerGroup struct {
	baseURL      string
	credentialID string
	api          ModelApi
	entries      []ConfiguredModel
}

func providerGroups(entries []ConfiguredModel) map[string]*providerGroup {
	groups := map[string]*providerGroup{}
	order := []string{}
	for _, entry := range entries {
		group := groups[entry.Provider]
		if group == nil {
			group = &providerGroup{baseURL: entry.BaseUrl, credentialID: entry.CredentialId, api: entry.Api, entries: []ConfiguredModel{entry}}
			groups[entry.Provider] = group
			order = append(order, entry.Provider)
			continue
		}
		if group.baseURL != entry.BaseUrl {
			Raise("invalid_config", fmt.Sprintf("Models for provider %q must share one baseUrl", entry.Provider))
		}
		if group.credentialID != entry.CredentialId {
			Raise("invalid_config", fmt.Sprintf("Models for provider %q must share one credentialId", entry.Provider))
		}
		if group.api != entry.Api {
			Raise("invalid_config", fmt.Sprintf("Models for provider %q must share one api", entry.Provider))
		}
		group.entries = append(group.entries, entry)
	}
	_ = order
	return groups
}

func missingSecrets(config GraphConfig, entries []ConfiguredModel, env map[string]string) []string {
	missing := []string{}
	seen := map[string]bool{}
	envPtr := map[string]*string{}
	for key, value := range env {
		copied := value
		envPtr[key] = &copied
	}
	for _, group := range providerGroups(entries) {
		secret := ResolveCredentialSecret(config, group.credentialID, envPtr)
		if !secret.Configured && secret.SecretRef != "" && !seen[secret.SecretRef] {
			seen[secret.SecretRef] = true
			missing = append(missing, secret.SecretRef)
		}
	}
	return missing
}

// StartGraphDaemon serves the console on loopback. It does not start the TypeScript server.
func StartGraphDaemon(options DaemonOptions) *GraphDaemon {
	WidenProcessPath(nil)
	log := options.Log
	if log == nil {
		log = func(string) {}
	}
	index := filepath.Join(options.WebDir, "index.html")
	if _, err := os.Stat(index); err != nil {
		Raise("web_build_missing", fmt.Sprintf("Web build not found at %s. Build the console first: pnpm build:web (without pnpm: node --run build:web)", index))
	}
	config := EmptyGraphConfig()
	if options.ConfigPath != nil {
		config = LoadGraphConfig(*options.ConfigPath)
	}
	var configStore *ConfigStore
	if options.ConfigPath != nil {
		configStore = OpenConfigStore(*options.ConfigPath)
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
		if !options.Dynamic && !live.Enabled() {
			return
		}
		for provider, group := range providerGroups(live.Entries()) {
			binding := live.CredentialFor(group.entries[0])
			if binding == nil {
				continue
			}
			modelRuntime.RegisterProvider(provider, ProviderRegistration{
				BaseURL: group.baseURL, API: group.api, APIKey: binding.APIKey, Models: append([]ConfiguredModel{}, group.entries...), Headers: ModelRequestHeaders(group.entries[0].ModelEntry),
			})
		}
	}
	// The capability view reads the secret values the host knows about, minus
	// the ones the user revoked.
	capabilitySecretValues := func() map[string]string {
		revoked := map[string]bool{}
		for _, ref := range live.Revoked() {
			revoked[ref] = true
		}
		values := map[string]string{}
		for ref, value := range options.Env {
			if revoked[ref] || strings.TrimSpace(value) == "" {
				continue
			}
			values[ref] = value
		}
		for ref, value := range live.Secrets() {
			if revoked[ref] || strings.TrimSpace(value) == "" {
				continue
			}
			values[ref] = value
		}
		return values
	}
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
	// Read once. A later read would describe a checkout this process is not running.
	runningSource := ReadSourceIdentity(ApplicationRoot)
	presetsRoot := options.PresetsDir
	if presetsRoot == "" {
		presetsRoot = filepath.Join(ApplicationRoot, "presets")
	}
	userHome := options.GraphHome
	if userHome == "" {
		userHome = GraphHome(options.Env)
	}
	bootstrap := LoadPresetBootstrap(presetsRoot, log)
	// TODO(port): bootstrap identity and tool prompt belong on the library; OpenAgentContextLibrary takes the prompts directory.
	agentContext := OpenAgentContextLibrary(filepath.Join(userHome, "prompts"))
	ensureAgentContext(agentContext)
	testConnection := func(modelID string) map[string]any {
		var entry *ConfiguredModel
		for _, candidate := range live.Entries() {
			if candidate.Id == modelID {
				copied := candidate
				entry = &copied
				break
			}
		}
		if entry == nil {
			Raise("not_found", "Unknown model "+modelID)
		}
		binding := live.CredentialFor(*entry)
		if binding == nil {
			return map[string]any{"ok": false, "model": entry.Id, "credentialId": entry.CredentialId, "message": "Credential not configured: " + entry.CredentialId}
		}
		started := NowMillis()
		anthropic := entry.Api == "anthropic-messages"
		path := "/chat/completions"
		if anthropic {
			path = "/messages"
		}
		body := map[string]any{"model": entry.Id, "messages": []any{map[string]any{"role": "user", "content": "ping"}}, "max_tokens": 1, "stream": false}
		if entry.ModelId != "" {
			body["model"] = entry.ModelId
		}
		payload, err := json.Marshal(body)
		if err != nil {
			panic(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(entry.BaseUrl, "/")+path, strings.NewReader(string(payload)))
		if err != nil {
			return map[string]any{"ok": false, "model": entry.Id, "credentialId": entry.CredentialId, "latencyMs": NowMillis() - started, "message": err.Error()}
		}
		request.Header.Set("content-type", "application/json")
		if anthropic {
			request.Header.Set("x-api-key", binding.APIKey)
			request.Header.Set("anthropic-version", "2023-06-01")
		} else {
			request.Header.Set("authorization", "Bearer "+binding.APIKey)
		}
		for key, value := range ModelRequestHeaders(entry.ModelEntry) {
			request.Header.Set(key, value)
		}
		response, err := HTTPClient.Do(request)
		if err != nil {
			return map[string]any{"ok": false, "model": entry.Id, "credentialId": entry.CredentialId, "latencyMs": NowMillis() - started, "message": err.Error()}
		}
		defer response.Body.Close()
		_, _ = io.Copy(io.Discard, response.Body)
		ok := response.StatusCode >= 200 && response.StatusCode < 300
		result := map[string]any{"ok": ok, "model": entry.Id, "credentialId": entry.CredentialId, "status": response.StatusCode, "latencyMs": NowMillis() - started}
		if !ok {
			result["message"] = fmt.Sprintf("HTTP %d", response.StatusCode)
		}
		return result
	}
	var server *GraphHost
	var configWatch *ConfigWatch
	var secrets *SecretPersist
	var configQueue sync.Mutex
	// The bootstrap pack publishes its own definitions. Without one the daemon
	// publishes the three built-in recipes once the configuration enables a model.
	presetsAvailable := false
	definitionsPublished := false
	publishDefinitions := func() {
		if presetsAvailable || definitionsPublished || !live.Enabled() {
			return
		}
		definitionsPublished = true
		catalog := runtimeCatalog(server)
		if catalog == nil {
			return
		}
		catalog.PublishDefinition("master", DefinitionSpec{RecommendedGrade: "high"})
		catalog.PublishDefinition("coder", DefinitionSpec{RecommendedGrade: "medium"})
		catalog.PublishDefinition("reviewer", DefinitionSpec{RecommendedGrade: "high", Review: true})
	}
	// The master Agent runs the definition the catalog currently holds. The
	// bootstrap pack ships a 'main' definition; without it the built-in
	// master@1 recipe is used.
	currentMasterDefinitionVersion := func() string {
		if bootstrap.Prompts["main"] == "" {
			return "master@1"
		}
		catalog := runtimeCatalog(server)
		if catalog == nil {
			return "master@1"
		}
		for _, item := range catalog.ListDefinitions() {
			if item.Id == "main" {
				return "main@" + itoa(int(item.Version))
			}
		}
		return "master@1"
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
			if !stringIn(live.Revoked(), ref) {
				if stored, ok := live.Secrets()[ref]; ok {
					copied := stored
					current = &copied
				}
			}
			stale := (pending != nil && !sameSecret(pending.Value, acknowledged)) || (pending == nil && current != nil && !sameSecret(current, acknowledged))
			if stale {
				if pending == nil && current != nil {
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
		if configStore == nil || config.Path == nil {
			Raise("invalid_config", "The daemon was started without a configuration file")
		}
		raw, err := os.ReadFile(*config.Path)
		if err != nil {
			panic(err)
		}
		var document any
		if err := json.Unmarshal(raw, &document); err != nil {
			panic(err)
		}
		verify := options.PriceVerify
		if verify == nil {
			verify = defaultPriceVerify
		}
		decisions := map[string]bool{}
		for _, snapshot := range PRICE_SNAPSHOT {
			decisions[snapshot.Provider+":"+snapshot.ModelId] = verify(snapshot)
		}
		retrievedAt := time.Now().UTC().Format("2006-01-02")
		refreshed, results := ApplyPriceSnapshot(document, func(snapshot PriceSnapshot) bool {
			return decisions[snapshot.Provider+":"+snapshot.ModelId]
		}, PRICE_SNAPSHOT_BASE+".refresh."+retrievedAt, retrievedAt)
		result := applyNow(refreshed, expectedRevision)
		result.Results = results
		if !result.Applied && result.Reason == nil {
			result.Reason = liveReason("refresh rejected")
		}
		return result
	}
	secrets = CreateSecretPersist()
	port := options.Port
	autoDrive := options.Mode == "execute" || options.Dynamic
	server = OpenGraphServer(GraphServerOptions{
		StateDir: stateDir, Projects: config.Projects, WebDir: options.WebDir, Port: &port, AutoDrive: &autoDrive,
		Codemode: config.Codemode,
		Models: &TaskRuntimeModels{
			Entries: live.Entries(), Preferences: live.Preferences(), ModelRuntime: modelRuntime, ModelScheduler: scheduler,
			CredentialFor: func(entry ConfiguredModel) *ResolvedCredential { return live.CredentialFor(entry) },
		},
		Live: &TaskRuntimeLive{
			Revision: live.Revision, Config: live.Config, Entries: live.Entries, Preferences: live.Preferences,
			CredentialFor: func(entry ConfiguredModel) *ResolvedCredential { return live.CredentialFor(entry) },
			MasterModel:   live.MasterModel, DefaultBudgetTokens: live.DefaultBudgetTokens, Projects: live.Projects,
		},
		Master: &TaskRuntimeMaster{
			Action: "master", Model: live.MasterModel, DefinitionVersion: currentMasterDefinitionVersion,
		},
		Catalog: &TaskRuntimeCatalog{
			CapabilityRoot: filepath.Join(userHome, "capabilities"), RecipesPath: filepath.Join(userHome, "agent-combinations.json"),
			BootstrapPrompts: bootstrap.Prompts, BootstrapToolPrompt: bootstrap.ToolPrompt,
		},
		Limits: &TaskRuntimeLimits{DefaultBudgetTokens: live.DefaultBudgetTokens},
		Access: live.Access, Usage: usage, Rsi: rsi, AgentContext: agentContext,
		// SystemContext is deliberately left unset: the daemon has no host
		// inventory to offer the main Agent yet, so the system tools stay
		// unavailable rather than reporting an empty one.
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
	// The catalog is ready once the runtime is open: the bootstrap pack
	// publishes its definitions, and the built-in recipes follow when the
	// configuration enables a model.
	presetResult := PublishBootstrap(runtimeCatalog(server), bootstrap, log)
	presetsAvailable = presetResult.Available
	publishDefinitions()
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
		URL: server.Url, StateDir: stateDir, WebDir: options.WebDir, ConfigPath: config.Path, Mode: options.Mode,
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

var secretRefPattern = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func readRevocations(path string, config GraphConfig) ([]string, string) {
	body, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, ""
		}
		return everySecretRef(config), err.Error()
	}
	var parsed []any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return everySecretRef(config), err.Error()
	}
	refs := []string{}
	for _, item := range parsed {
		text, ok := item.(string)
		if !ok {
			return everySecretRef(config), "expected a JSON array of secret refs"
		}
		refs = append(refs, text)
	}
	return refs, ""
}

func everySecretRef(config GraphConfig) []string {
	seen := map[string]bool{}
	refs := []string{}
	for _, credential := range config.Credentials {
		if credential.SecretRef != "" && !seen[credential.SecretRef] {
			seen[credential.SecretRef] = true
			refs = append(refs, credential.SecretRef)
		}
	}
	sort.Strings(refs)
	return refs
}

// runtimeCatalog is the catalog the runtime owns. The daemon publishes the
// bootstrap definitions and the built-in recipes into it.
func runtimeCatalog(host *GraphHost) *Catalog {
	if host == nil {
		return nil
	}
	if host.Runtime == nil {
		return nil
	}
	return host.Runtime.catalog
}

// ensureMainRecipe keeps the 'main' Agent combination in the shape the master
// Agent needs. A recipe that cannot be written is reported and the bootstrap
// master@1 stays in use.
func ensureMainRecipe(catalog *Catalog, bootstrap PresetBootstrap, log func(string)) {
	if catalog == nil || bootstrap.Prompts["main"] == "" {
		return
	}
	if problem := catalog.AgentCombinationError(); problem != nil && *problem != "" {
		log("Main Agent recipe unavailable (" + *problem + "); using bootstrap master@1.")
		return
	}
	var existing *AgentCombinationView
	for _, item := range catalog.AgentCombinations() {
		if item.Id == "main" {
			copied := item
			existing = &copied
			break
		}
	}
	err := portRecover(func() {
		if existing == nil {
			catalog.SaveAgentCombination(AgentCombination{
				Id: "main", Name: "Atlas_main",
				Description:      "持续面对用户、规划任务、设计并监控 Graph，并在确认范围内组装和调用 subagents。",
				Mode:             "main",
				RecommendedGrade: "high",
				Tags:             []string{"main", "system"},
				Resources:        []AgentCombinationResource{},
			})
			return
		}
		if existing.Mode != "main" {
			updated := existing.AgentCombination
			updated.Mode = "main"
			catalog.SaveAgentCombination(updated)
			return
		}
		catalog.CompileAgentCombination("main")
	})
	if err != nil {
		log("Main Agent recipe unavailable (" + err.Error() + "); using bootstrap master@1.")
	}
}

// failedDefinitionsSuffix describes the bootstrap entries that did not install.
func failedDefinitionsSuffix(failed []PresetFailure) string {
	if len(failed) == 0 {
		return ""
	}
	return fmt.Sprintf(", %d failed", len(failed))
}

func writeRevocations(path string, refs []string) error {
	seen := map[string]bool{}
	unique := []string{}
	for _, ref := range refs {
		if !seen[ref] {
			seen[ref] = true
			unique = append(unique, ref)
		}
	}
	sort.Strings(unique)
	body, err := json.MarshalIndent(unique, "", "  ")
	if err != nil {
		return err
	}
	temporary := fmt.Sprintf("%s.%d.%s.tmp", path, os.Getpid(), graphUUID())
	if err := os.WriteFile(temporary, append(body, '\n'), 0o600); err != nil {
		return err
	}
	return os.Rename(temporary, path)
}

func defaultPriceVerify(snapshot PriceSnapshot) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, snapshot.SourceUrl, nil)
	if err != nil {
		return false
	}
	request.Header.Set("user-agent", "graph-price-refresh/1")
	response, err := HTTPClient.Do(request)
	if err != nil {
		return false
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return false
	}
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return false
	}
	return strings.Contains(string(body), snapshot.ModelId)
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	seen := map[string]int{}
	for _, item := range left {
		seen[item]++
	}
	for _, item := range right {
		seen[item]--
		if seen[item] < 0 {
			return false
		}
	}
	return true
}

func envPointers(values map[string]string) map[string]*string {
	out := map[string]*string{}
	for key, value := range values {
		copied := value
		out[key] = &copied
	}
	return out
}

func mergeEnv(base, extra map[string]string) map[string]string {
	out := map[string]string{}
	for key, value := range base {
		out[key] = value
	}
	for key, value := range extra {
		out[key] = value
	}
	return out
}

func sameSecret(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}

func stringIn(values []string, needle string) bool {
	for _, value := range values {
		if value == needle {
			return true
		}
	}
	return false
}

// cliCwd is the working directory this process runs in. The RSI root falls back to it
// when no explicit root is configured.
func cliCwd() string {
	wd, err := os.Getwd()
	if err != nil {
		return "."
	}
	return wd
}
