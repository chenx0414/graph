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

// ControlledGatedProviderFetch sends one provider request behind the gate.
//
// One logical provider request. A transport failure before any response header
// cannot prove the provider did not receive or bill the request, so it is
// recorded as unknown usage and never resent silently. Only failures that prove
// nothing was sent (DNS failure, refused connection, connect timeout) are
// resent, and each resend is a new invocation that passes the gate again.
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
		// A request body is a stream: the first attempt drains it, so every later attempt needs a
		// fresh one. Without this the retry never leaves the process - the transport refuses a
		// ContentLength that no longer matches the empty body - and a capacity answer becomes a
		// failed turn although the provider asked for a later attempt.
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
		// Correlation diagnostics never change a send or its usage evidence: a
		// watcher that fails is not a reason to fail the turn.
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
		if options.AcquireSlot != nil {
			release = options.AcquireSlot()
		}
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
			// The request left the process and no header came back: the provider
			// may have received it and may have billed it. The usage stays
			// unknown, and the failure is named by identifiers only.
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
				return nil, failure
			}
			if notSent {
				delay(500 * attempt)
				continue
			}
			// The response never started: no reply byte was read, so no tool can
			// have run and the turn may be sent again. The failed attempt's usage
			// stays unknown - the provider may still have billed the request -
			// and the retry dials a fresh connection instead of reusing the one
			// that just died.
			if controlledReplayableFailure(failure) {
				request.Close = true
				delay(1000 * attempt)
				continue
			}
			return nil, failure
		}
		// The headers are the first thing the provider said about the request:
		// a status is not token evidence, and a correlation id may come back
		// with it.
		status := response.StatusCode
		observe(ProviderTransportObservation{
			Phase:       "response_headers",
			Status:      &status,
			ResponseIDs: controlledResponseRequestIds(response.Header),
		})
		// A capacity answer (429 or 503) means the provider rejected the request before producing any
		// token, exactly like an unsent connection: give the same logical send another attempt instead
		// of failing the Agent turn. Other 5xx answers stay hard failures - they can be a provider bug
		// that the unknown-usage path must see. Settling zero usage matters too: an unknown settlement
		// would turn a provider hiccup into a blocking usage question for the user.
		//
		// The retry waits for the pause the provider asked for. A rate limit is not a failed send: a
		// half-second retry turns one capacity answer into a burst of full-size requests that all land
		// in the same window, and the turn fails although waiting would have succeeded.
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
		// Capacity covers the whole body, not just the headers.
		if response.Body != nil {
			response.Body = &controlledReleaseBody{ReadCloser: response.Body, release: release}
		} else {
			release()
		}
		return response, nil
	}
}

// controlledReplayableFailure reports whether one attempt failed before any
// response byte arrived, without the caller asking it to stop.
//
// A dropped socket, a reset and a corrupted TLS record all qualify: nothing was
// read, so no tool can have run, and the same send may be tried on a fresh
// connection. A cancellation or a certificate the proxy cannot satisfy does
// not: the retry would repeat the same refusal or ignore the caller.
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

// controlledCapacityPause is how long a capacity answer asks the next attempt to wait.
//
// Retry-After is the provider's own statement and wins when it is readable. Without one the backoff
// grows on its own (10s, 20s, then the cap) so the next attempt leaves the window that refused the
// first one. The bounds matter both ways: a malformed or absent hint still pauses, and an absurd one
// cannot hold the turn for minutes.
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

// controlledRetryAfter reads the seconds or HTTP date of a Retry-After header.
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

// controlledCapacityBound keeps one pause between no wait and one minute.
func controlledCapacityBound(milliseconds int) int {
	if milliseconds < 0 {
		return 0
	}
	if milliseconds > 60_000 {
		return 60_000
	}
	return milliseconds
}

// ControlledRequestToolDeclarations reads the tool declarations one request body carries.
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
