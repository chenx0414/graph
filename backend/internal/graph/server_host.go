package graph

import (
	"path/filepath"
	"strings"
	"sync"
	"time"
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
	Origin        string
	WebDir        string
	Startup       *StartupInfo
	StartupInfo   func() StartupInfo
	ConfigStore   any
	ConfigEnv     map[string]*string
	ConfigTest    func(modelId string) any
	AppServices   *AppServices
	Usage         any
	SystemContext any
	AgentContext  any
}

// GraphServerOptions is the daemon open request. The TypeScript host spreads the same
// object into OpenTaskRuntime; fields this function does not read are still forwarded.
type GraphServerOptions struct {
	StateDir      string
	Projects      []ProjectConfig
	WebDir        string
	Port          *int
	AutoDrive     *bool
	Origin        string
	Startup       *StartupInfo
	StartupInfo   func() StartupInfo
	ConfigStore   any
	ConfigEnv     map[string]*string
	ConfigTest    func(modelId string) any
	AppServices   *AppServices
	Usage         any
	SystemContext any
	AgentContext  any
	Models        any
	Actions       any
	Master        any
	Network       any
	Limits        any
	Access        any
	Live          any
	Program       any
	Rsi           any
	Catalog       any
	// Kernel selects the Agent kernel: "node" (the TypeScript durable
	// sidecar) or "pig" (the Go PiG kernel). Empty is "node".
	Kernel string
}

// GraphHost is the listening daemon and its drive loop.
type GraphHost struct {
	Runtime any
	App     any
	Url     string

	mu       sync.Mutex
	driving  bool
	stopped  bool
	closed   bool
	loopDone chan struct{}
	runtime  interface {
		Close()
	}
	app interface {
		Close()
		CloseAllConnections()
	}
	pump func()
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
		AppServices: options.AppServices, Usage: options.Usage, SystemContext: options.SystemContext, AgentContext: agentContext,
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
		Runtime: runtime, App: app, Url: url, driving: autoDrive, loopDone: make(chan struct{}),
		runtime: runtime, app: app, pump: func() { runtime.Host.Pump() },
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
	h.runtime.Close()
}

func ensureAgentContext(library any) {
	type ensurer interface{ Ensure() }
	if library, ok := library.(ensurer); ok {
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
