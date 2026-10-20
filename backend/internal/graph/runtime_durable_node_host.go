package graph

import (
	"errors"
	"sync"
)

type ResidentInspect = PiWorkerInspect
type ResidentTurnUsage struct {
	Input      int64 `json:"input"`
	Output     int64 `json:"output"`
	CacheRead  int64 `json:"cacheRead"`
	CacheWrite int64 `json:"cacheWrite"`
	Total      int64 `json:"total"`
	Accounted  *bool `json:"accounted,omitempty"`
}

// ResidentTurnResult is one finished turn of a resident session.
type ResidentTurnResult struct {
	TurnId  string             `json:"turnId"`
	Inspect ResidentInspect    `json:"inspect"`
	Usage   *ResidentTurnUsage `json:"usage,omitempty"`
}

// ResidentToolAnswer is the host's answer to a tool the node called.
type ResidentToolAnswer struct {
	Ok   bool   `json:"ok"`
	Text string `json:"text"`
}

type ResidentWorkerConfig struct {
	PiWorkerConfig
	HostModel bool `json:"hostModel,omitempty"`
}
type ResidentHostOptions struct {
	DurableInput func() string
	DurableUsage func() *ResidentTurnUsage
	Config       ResidentWorkerConfig
	OnModelCall  func(any, *AbortSignal, WorkerModelOptions) (any, error)
	OnEvent      func(any)
	OnTelemetry  func(PiAdapterToolCall)
	OnReady      func(ResidentInspect)
	OnToolCall   func(string, any) (ResidentToolAnswer, error)
}
type ResidentHost struct {
	options                 ResidentHostOptions
	mutex                   sync.Mutex
	durable                 *durableClient
	durableOwner            *durableOwner
	durableStarted          bool
	disposed                bool
	recoveredAttemptChecked bool
	modelAborts             map[*AbortSignal]bool
}

func NewResidentHost(options ResidentHostOptions) *ResidentHost {
	return &ResidentHost{options: options, modelAborts: map[*AbortSignal]bool{}}
}
func (host *ResidentHost) Start() (ResidentInspect, error) {
	if host.disposed {
		return ResidentInspect{}, errors.New("Durable node binding is closed")
	}
	return host.startDurable()
}
func (host *ResidentHost) Turn(text string) (ResidentTurnResult, error) {
	return host.turnDurable(text)
}
func (host *ResidentHost) Alive() bool {
	host.mutex.Lock()
	defer host.mutex.Unlock()
	return host.durableStarted && !host.disposed
}
func (host *ResidentHost) Stop() error {
	host.mutex.Lock()
	client := host.durable
	host.durableStarted = false
	host.mutex.Unlock()
	if client != nil {
		return client.call("stop", nil, nil)
	}
	return nil
}
func (host *ResidentHost) Dispose() error {
	host.mutex.Lock()
	host.disposed = true
	host.mutex.Unlock()
	return host.Stop()
}
