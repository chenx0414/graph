package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"time"
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
		id := graphUUID()
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
			code := controlledTransportCode(failure)
			notSent := code != "" && controlledRetryableTransportCodes[code]
			if notSent {
				broker.Settle(id, &controlledZeroUsage)
			} else {
				broker.Settle(id, nil)
			}
			if !notSent || attempt >= maxAttempts {
				return nil, failure
			}
			delay(500 * attempt)
			continue
		}
		// A capacity answer (429 or 503) means the provider rejected the request before producing any
		// token, exactly like an unsent connection: give the same logical send another attempt instead
		// of failing the Agent turn. Other 5xx answers stay hard failures - they can be a provider bug
		// that the unknown-usage path must see. Settling zero usage matters too: an unknown settlement
		// would turn a provider hiccup into a blocking usage question for the user.
		if (response.StatusCode == http.StatusTooManyRequests || response.StatusCode == http.StatusServiceUnavailable) && attempt < maxAttempts {
			release()
			broker.Settle(id, nil)
			if response.Body != nil {
				_ = response.Body.Close()
			}
			delay(500 * attempt)
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
