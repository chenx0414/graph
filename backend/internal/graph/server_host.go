package graph

import (
	"strings"
	"sync"
	"time"

	"path/filepath"
)

// StartupInfo is the boot snapshot the console reads. Source is filled once, at startup.
type StartupInfo struct {
	Mode              string            `json:"mode"`
	Configured        bool              `json:"configured"`
	ModelCount        int               `json:"modelCount"`
	EnabledModelCount int               `json:"enabledModelCount"`
	EffectiveRevision *int              `json:"effectiveRevision,omitempty"`
	LimitAliases      map[string]string `json:"limitAliases,omitempty"`
	Source            *SourceIdentity   `json:"source,omitempty"`
}

// AppServices is the host side of configuration, secrets and RSI.
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

// AppRsiService is the app bridge's RSI surface: the desktop polls the status
// and acknowledges a pending reload.
type AppRsiService struct {
	Status func(compare bool) any
	Ack    func(id string) any
}

// AppOptions is the slice of host options CreateApp reads.
type AppOptions struct {
	Origin       string
	WebDir       string
	Startup      *StartupInfo
	StartupInfo  func() StartupInfo
	ConfigStore  *ConfigStore
	ConfigEnv    map[string]*string
	ConfigTest   func(modelId string) any
	AppServices  *AppServices
	Usage        UsageService
	AgentContext *AgentContextLibrary
}

// GraphServerOptions is the daemon open request. Every field names the type it
// carries, so the compiler checks the seam between the daemon and the runtime.
type GraphServerOptions struct {
	StateDir      string
	Projects      []ProjectConfig
	WebDir        string
	Port          *int
	AutoDrive     *bool
	Origin        string
	Startup       *StartupInfo
	StartupInfo   func() StartupInfo
	ConfigStore   *ConfigStore
	ConfigEnv     map[string]*string
	ConfigTest    func(modelId string) any
	AppServices   *AppServices
	Usage         UsageService
	SystemContext *TaskRuntimeSystemContext
	AgentContext  *AgentContextLibrary
	Models        *TaskRuntimeModels
	Master        *TaskRuntimeMaster
	Limits        *TaskRuntimeLimits
	Access        func() AccessPolicy
	Live          *TaskRuntimeLive
	Rsi           *RsiService
	Catalog       *TaskRuntimeCatalog
	// Codemode offers the kernel's codemode tool to the Agent sessions. It
	// is off by default.
	Codemode GraphCodemode
	// OnCredentialRejected renews an OAuth credential after the vendor rejected it.
	// The app wires it, because the refresh token lives behind the host's secret
	// store.
	OnCredentialRejected func(request CredentialRecoveryRequest) bool
}

// How often the harness looks for problems nobody acted on. The sweep is one
// indexed read, but it does not need to ride every drive tick.
const problemSweepMs = 60 * 1000

// unsettledSweepMs is how often an operation whose outcome was never settled is
// handed to the main Agent.
const unsettledSweepMs = 60 * 1000

// autoAnswerSweepMs is how often an unanswered ask_user question is checked
// against its deadline.
const autoAnswerSweepMs = 60 * 1000

// GraphHost is the listening daemon and its drive loop.
type GraphHost struct {
	Runtime *TaskRuntime
	Url     string

	mu       sync.Mutex
	driving  bool
	stopped  bool
	closed   bool
	loopDone chan struct{}
	app      *GraphApp
	pump     func()
	// lastProblemSweep is only touched by the drive loop.
	lastProblemSweep int64
	// lastUnsettledSweep is only touched by the drive loop.
	lastUnsettledSweep int64
	// lastAutoAnswerSweep is only touched by the drive loop.
	lastAutoAnswerSweep int64
}

// OpenGraphServer binds 127.0.0.1 and drives the runtime.
// The TypeScript module's launchGoFromHostOptions prefix is the test harness
// starting this process; this function is the listen and drive loop that prefix replaced.
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
		Origin: origin, WebDir: options.WebDir, Startup: options.Startup, StartupInfo: options.StartupInfo,
		ConfigStore: options.ConfigStore, ConfigEnv: options.ConfigEnv, ConfigTest: options.ConfigTest,
		AppServices: options.AppServices, Usage: options.Usage, AgentContext: agentContext,
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
		app: app, pump: func() { runtime.Host.Pump() },
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
		// A problem nobody acted on still belongs to someone. Handing it over is
		// not a retry: it only makes the decision visible (see SweepUnattendedProblems).
		if now := NowMillis(); now-h.lastProblemSweep >= problemSweepMs {
			h.lastProblemSweep = now
			func() {
				defer func() { _ = recover() }()
				h.Runtime.SweepUnattendedProblems(now)
			}()
		}
		// A reload asked for during a turn waits for the first idle moment:
		// closing the host while an extension is being called would kill work
		// the person already paid for.
		func() {
			defer func() { _ = recover() }()
			h.Runtime.ApplyDeferredExtensionReload()
		}()
		// An operation whose outcome was never settled is invisible otherwise: no
		// result, no usage, no question. Hand it to main a few at a time, and close
		// the ones whose problem is already answered - an answered problem that left
		// its operation "unknown" for ever kept the task looking busy.
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
		// An ask_user nobody came back to takes the asker's recommended option.
		if now := NowMillis(); now-h.lastAutoAnswerSweep >= autoAnswerSweepMs {
			h.lastAutoAnswerSweep = now
			func() {
				defer func() { _ = recover() }()
				h.Runtime.SweepAutoAnswerQuestions(now)
			}()
		}
		if driving {
			func() {
				defer func() { _ = recover() }()
				h.pump()
			}()
		}
		delay := 200 * time.Millisecond
		if driving {
			delay = 40 * time.Millisecond
		}
		time.Sleep(delay)
	}
}

func (h *GraphHost) StartDrive() {
	h.mu.Lock()
	h.driving = true
	h.mu.Unlock()
}

func (h *GraphHost) StopDrive() {
	h.mu.Lock()
	h.driving = false
	h.mu.Unlock()
}

func (h *GraphHost) Driving() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.driving
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
