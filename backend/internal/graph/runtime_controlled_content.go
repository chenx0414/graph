package graph

import (
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"encoding/json"
)

func ControlledGatedProviderFetch(broker SendGate, request *http.Request, options GatedProviderFetchOptions) (*http.Response, error) {
	maxAttempts := options.MaxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	delay := options.Delay
	if delay == nil {
		delay = func(milliseconds int) { time.Sleep(time.Duration(milliseconds) * time.Millisecond) }
	}
	for attempt := 1; ; attempt++ {
		if attempt > 1 {
			if request.GetBody == nil {
				return nil, errors.New("the request body cannot be replayed")
			}
			body, err := request.GetBody()
			if err != nil {
				return nil, err
			}
			request.Body = body
		}
		id := graphUUID()
		requestSha256 := controlledRequestSha256(request)
		observe := func(observation ProviderTransportObservation) {
			if options.OnTransport == nil {
				return
			}
			observation.CallID = id
			observation.At = NowMillis()
			observation.RequestSha256 = requestSha256
			if options.RequestIDHeader != "" {
				clientRequestID := id
				observation.ClientRequestID = &clientRequestID
			}
			func() {
				defer func() { _ = recover() }()
				options.OnTransport(observation)
			}()
		}
		sent := false
		release := func() {}
		var response *http.Response
		var failure error
		func() {
			defer func() {
				if recovered := recover(); recovered != nil {
					if err, ok := recovered.(error); ok {
						failure = err
						return
					}
					failure = fmt.Errorf("%v", recovered)
				}
			}()
			if options.AcquireSlot != nil {
				release = options.AcquireSlot()
			}
			result := broker.Dispatch(id, options.Reservation, func() any {
				if options.OnRequest != nil {
					options.OnRequest(id)
				}
				sent = true
				if options.RequestIDHeader != "" {
					request.Header.Set(options.RequestIDHeader, id)
				}
				observe(ProviderTransportObservation{Phase: "fetch_started"})
				fetch := options.FetchImpl
				if fetch == nil {
					fetch = func(req *http.Request) (*http.Response, error) { return HTTPClient.Do(req) }
				}
				answer, err := fetch(request)
				if err != nil {
					panic(err)
				}
				return answer
			})
			if result == nil {
				failure = errors.New("The send gate returned no response")
				return
			}
			answer, ok := result.(*http.Response)
			if !ok {
				failure = errors.New("The send gate returned no response")
				return
			}
			response = answer
		}()
		if failure != nil {
			release()
			if !sent {
				return nil, failure
			}
			recoverable := false
			observe(ProviderTransportObservation{
				Phase:                         "transport_error",
				ErrorCodes:                    controlledTransportErrorCodes(failure),
				ErrorNames:                    controlledTransportErrorNames(failure),
				UsageRecoverableFromTransport: &recoverable,
			})
			code := controlledTransportCode(failure)
			notSent := code != "" && controlledRetryableTransportCodes[code]
			if notSent || options.ReclaimUnanswered {
				broker.Settle(id, &controlledZeroUsage)
			} else {
				broker.Settle(id, nil)
			}
			if attempt >= maxAttempts {
				return nil, TransportRetryExhausted(failure, attempt-1)
			}
			if notSent {
				delay(500 * attempt)
				continue
			}
			if controlledReplayableFailure(failure) {
				request.Close = true
				delay(1000 * attempt)
				continue
			}
			return nil, failure
		}
		status := response.StatusCode
		observe(ProviderTransportObservation{
			Phase:       "response_headers",
			Status:      &status,
			ResponseIDs: controlledResponseRequestIds(response.Header),
		})
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusServiceUnavailable) && attempt < maxAttempts {
			release()
			broker.Settle(id, nil)
			pause := controlledCapacityPause(response.Header.Get("Retry-After"), attempt)
			if response.Body != nil {
				_ = response.Body.Close()
			}
			delay(pause)
			continue
		}
		if options.OnResponse != nil {
			options.OnResponse(id, response, release)
			return response, nil
		}
		if response.Body != nil {
			response.Body = &controlledReleaseBody{ReadCloser: response.Body, release: release}
		} else {
			release()
		}
		return response, nil
	}
}

func controlledReplayableFailure(err error) bool {
	for _, code := range controlledTransportErrorCodes(err) {
		if code == "CANCELED" || code == "DEADLINE_EXCEEDED" {
			return false
		}
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "x509") || strings.Contains(message, "certificate") {
		return false
	}
	return true
}

func controlledCapacityPause(header string, attempt int) int {
	if pause, ok := controlledRetryAfter(header); ok {
		return pause
	}
	pause := 10_000
	for retry := 1; retry < attempt && pause < 30_000; retry++ {
		pause *= 2
	}
	if pause > 30_000 {
		pause = 30_000
	}
	return pause
}

func controlledRetryAfter(header string) (int, bool) {
	value := strings.TrimSpace(header)
	if value == "" {
		return 0, false
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		return controlledCapacityBound(seconds * 1000), true
	}
	if at, err := http.ParseTime(value); err == nil {
		return controlledCapacityBound(int(time.Until(at).Milliseconds())), true
	}
	return 0, false
}

func controlledCapacityBound(milliseconds int) int {
	if milliseconds < 0 {
		return 0
	}
	if milliseconds > 60_000 {
		return 60_000
	}
	return milliseconds
}

func ControlledRequestToolDeclarations(body []byte) *string {
	if len(body) == 0 {
		return nil
	}
	var parsed map[string]any
	if err := json.Unmarshal(body, &parsed); err != nil {
		return nil
	}
	tools, ok := parsed["tools"].([]any)
	if !ok || len(tools) == 0 {
		return nil
	}
	encoded, err := json.Marshal(tools)
	if err != nil {
		return nil
	}
	return stringPointer(string(encoded))
}
