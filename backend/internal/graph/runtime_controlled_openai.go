package graph

import (
	"net/http"
)

type SendGate struct {
	Dispatch func(id string, reservation float64, send func() any) any
	Settle func(id string, usage *TokenUsage)
}

type ControlledStreamUsageOptions = PiAdapterStreamOptions

type GatedProviderFetchOptions struct {
	Reservation float64
	FetchImpl func(request *http.Request) (*http.Response, error)
	Delay func(milliseconds int)
	MaxAttempts int
	AcquireSlot func() func()
	OnResponse func(id string, response *http.Response, release func())
	OnRequest func(id string)
	OnTransport func(observation ProviderTransportObservation)
	RequestIDHeader string
	ReclaimUnanswered bool
}
