package graph

import (
	"strings"
	"sync"
	"time"

	"path/filepath"
)

type StartupInfo struct {
	Mode              string            `json:"mode"`
	Configured        bool              `json:"configured"`
	ModelCount        int               `json:"modelCount"`
	EnabledModelCount int               `json:"enabledModelCount"`
	EffectiveRevision *int              `json:"effectiveRevision,omitempty"`
	LimitAliases      map[string]string `json:"limitAliases,omitempty"`
	Source            *SourceIdentity   `json:"source,omitempty"`
}

type AppServices struct {
	ApplyConfig           func(document any, expectedRevision int) any
	PushSecret            func(ref string, value *string, persisted *bool) any
	PendingSecretRequests func() []SecretPersistRequest
	ConfigWatch           func() *ConfigWatchReport
	AppToken              string
	Snapshot              func() any
	RefreshPrices         func(expectedRevision int) any
	CapabilityConfig      *struct {
		SecretValues func() map[string]string
	}
	Rsi *AppRsiService
}

type AppRsiService struct {
	Status func(compare bool) any
	Ack    func(id string) any
}

type AppOptions struct {
	Origin       string
	Startup      *StartupInfo
	StartupInfo  func() StartupInfo
	ConfigStore  *ConfigStore
	ConfigEnv    map[string]*string
	ConfigTest   func(modelId string) any
	AppServices  *AppServices
	Usage        UsageService
	AgentContext *AgentContextLibrary
	Ready        func() bool
}

type GraphServerOptions struct {
	StateDir             string
	Projects             []ProjectConfig
	Port                 *int
	AutoDrive            *bool
	Origin               string
	Startup              *StartupInfo
	StartupInfo          func() StartupInfo
	ConfigStore          *ConfigStore
	ConfigEnv            map[string]*string
	ConfigTest           func(modelId string) any
	AppServices          *AppServices
	Usage                UsageService
	SystemContext        *TaskRuntimeSystemContext
	AgentContext         *AgentContextLibrary
	Models               *TaskRuntimeModels
	Magpie               *MagpieModels
	Master               *TaskRuntimeMaster
	Limits               *TaskRuntimeLimits
	Live                 *TaskRuntimeLive
	Rsi                  *RsiService
	Catalog              *TaskRuntimeCatalog
	Codemode             GraphCodemode
	OnCredentialRejected func(request CredentialRecoveryRequest) bool
	Ready                func() bool
}

const problemSweepMs = 60 * 1000

const unsettledSweepMs = 60 * 1000

type GraphHost struct {
	Runtime *TaskRuntime
	Url     string

	mu                 sync.Mutex
	driving            bool
	stopped            bool
	closed             bool
	loopDone           chan struct{}
	app                *GraphApp
	pump               func() ExecutionDispatch
	lastProblemSweep   int64
	lastUnsettledSweep int64
	lastRetentionSweep int64
}

func graphDriveDelay(dispatched int) time.Duration {
	if dispatched > 0 {
		return 20 * time.Millisecond
	}
	return 500 * time.Millisecond
}

func OpenGraphServer(options GraphServerOptions) *GraphHost {
	agentContext := options.AgentContext
	if agentContext == nil {
		agentContext = OpenAgentContextLibrary(filepath.Join(options.StateDir, "prompts"))
	}
	ensureAgentContext(agentContext)
	autoDrive := options.AutoDrive != nil && *options.AutoDrive
	options.AgentContext = agentContext
	options.AutoDrive = &autoDrive
	runtime := OpenTaskRuntime(options)
	origin := options.Origin
	if origin == "" {
		origin = "http://127.0.0.1"
	}
	app := CreateApp(runtime, AppOptions{
		Origin: origin, Startup: options.Startup, StartupInfo: options.StartupInfo,
		ConfigStore: options.ConfigStore, ConfigEnv: options.ConfigEnv, ConfigTest: options.ConfigTest,
		AppServices: options.AppServices, Usage: options.Usage, AgentContext: agentContext,
		Ready: options.Ready,
	})
	requested := 0
	if options.Port != nil {
		requested = *options.Port
	}
	bindPort := requested
	if requested == 0 {
		if preferred := PreferredConsolePort(options.StateDir, PortIsFree, 5000); preferred != nil {
			bindPort = *preferred
		}
	}
	address, err := app.Listen("127.0.0.1", bindPort)
	if err != nil {
		_ = closeQuiet(func() { app.Close() })
		_ = closeQuiet(func() { runtime.Close() })
		if addrInUse(err) {
			Raise("port_in_use", "Port "+itoaPort(requested)+" is already in use on 127.0.0.1; choose another port with --port")
		}
		panic(err)
	}
	url := address
	if url == "" {
		url = "http://127.0.0.1:" + itoaPort(bindPort)
	}
	host := &GraphHost{
		Runtime: runtime, Url: url, driving: autoDrive, loopDone: make(chan struct{}),
		app: app, pump: func() ExecutionDispatch { return runtime.Host.Pump() },
	}
	go host.drive()
	return host
}

func (h *GraphHost) drive() {
	defer close(h.loopDone)
	for {
		h.mu.Lock()
		stopped := h.stopped
		driving := h.driving
		h.mu.Unlock()
		if stopped {
			return
		}
		if now := NowMillis(); now-h.lastProblemSweep >= problemSweepMs {
			h.lastProblemSweep = now
			func() {
				defer func() { _ = recover() }()
				h.Runtime.SweepUnattendedProblems(now)
			}()
		}
		func() {
			defer func() { _ = recover() }()
			h.Runtime.ApplyDeferredExtensionReload()
		}()
		if now := NowMillis(); now-h.lastUnsettledSweep >= unsettledSweepMs {
			h.lastUnsettledSweep = now
			func() {
				defer func() { _ = recover() }()
				h.Runtime.SweepUnsettledOperations(now)
			}()
			func() {
				defer func() { _ = recover() }()
				h.Runtime.AbandonClosedUnsettledOperations(now)
			}()
		}
		dispatched := 0
		if driving {
			func() {
				defer func() { _ = recover() }()
				dispatched = h.pump().Dispatched
			}()
		}
		if now := NowMillis(); now-h.lastRetentionSweep >= stateSweepIntervalMs() {
			h.lastRetentionSweep = now
			func() {
				defer func() { _ = recover() }()
				h.Runtime.execution.sweepState()
			}()
		}
		time.Sleep(graphDriveDelay(dispatched))
	}
}

func (h *GraphHost) StartDrive() {
	h.mu.Lock()
	h.driving = true
	h.mu.Unlock()
}

func (h *GraphHost) Close() {
	h.mu.Lock()
	if h.closed {
		h.mu.Unlock()
		return
	}
	h.closed = true
	h.stopped = true
	h.mu.Unlock()
	<-h.loopDone
	h.app.CloseAllConnections()
	h.app.Close()
	h.Runtime.Close()
}

func ensureAgentContext(library *AgentContextLibrary) {
	if library != nil {
		library.Ensure()
	}
}

func closeQuiet(fn func()) (failed error) {
	defer func() { _ = recover() }()
	fn()
	return nil
}

func addrInUse(err error) bool {
	if err == nil {
		return false
	}
	text := err.Error()
	return strings.Contains(text, "address already in use") || strings.Contains(text, "EADDRINUSE")
}

func itoaPort(port int) string {
	return strings.TrimPrefix(strings.ReplaceAll(jsonStringify(port), `"`, ""), "")
}
