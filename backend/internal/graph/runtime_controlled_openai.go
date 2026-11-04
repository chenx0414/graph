package graph

import (
	"net/http"
)

// Pause and usage gate around one actual provider send. CallBroker satisfies this.
//
// The reservation is a token count and the send is the work the gate wraps.
type SendGate struct {
	// Dispatch runs one send behind the gate and returns what the send returned.
	Dispatch func(id string, reservation float64, send func() any) any
	// Settle records the usage evidence of one send.
	Settle func(id string, usage *TokenUsage)
}

// ControlledStreamUsageOptions are the observations one controlled send reports.
type ControlledStreamUsageOptions = PiAdapterStreamOptions

// GatedProviderFetchOptions are the knobs one gated provider send carries.
type GatedProviderFetchOptions struct {
	// Reservation is the upper bound of tokens this send may use.
	Reservation float64
	// FetchImpl performs the actual request.
	FetchImpl func(request *http.Request) (*http.Response, error)
	// Delay waits between attempts.
	Delay func(milliseconds int)
	// MaxAttempts is how many times one logical send may be tried.
	MaxAttempts int
	// AcquireSlot acquires a concurrency slot for one attempt; released on retry, failure or
	// response end.
	AcquireSlot func() func()
	// OnResponse is called once for the successful attempt so the caller can settle its usage.
	OnResponse func(id string, response *http.Response, release func())
	// OnRequest is the best-effort observation after admission, once per actual transport attempt.
	OnRequest func(id string)
	// OnTransport observes every provider attempt after admission: what left, what came
	// back and how it failed.
	OnTransport func(observation ProviderTransportObservation)
	// RequestIDHeader names the correlation header the provider may forward.
	RequestIDHeader string
	// ReclaimUnanswered settles an attempt that came back with no response at all
	// as producing no usage. The caller sets it when a configured fallback takes
	// the send over: the failed attempt cannot keep an unknown call that would
	// refuse the very next send.
	ReclaimUnanswered bool
}
