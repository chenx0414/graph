package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"syscall"
	"time"
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
}

// controlledTransportCode reads the transport failure one error carries.
func controlledTransportCode(err error) string {
	if err == nil {
		return ""
	}
	var dnsError *net.DNSError
	if errors.As(err, &dnsError) {
		return "ENOTFOUND"
	}
	var opError *net.OpError
	if errors.As(err, &opError) {
		if opError.Timeout() {
			return "UND_ERR_CONNECT_TIMEOUT"
		}
		var syscallError *os.SyscallError
		if errors.As(opError.Err, &syscallError) && syscallError.Err == syscall.ECONNREFUSED {
			return "ECONNREFUSED"
		}
	}
	var netError net.Error
	if errors.As(err, &netError) && netError.Timeout() {
		return "UND_ERR_CONNECT_TIMEOUT"
	}
	return ""
}

// controlledReleaseBody is a response body that gives the concurrency slot back when it closes.
type controlledReleaseBody struct {
	io.ReadCloser
	release func()
	once    bool
}

// Close closes the body and releases the slot.
func (body *controlledReleaseBody) Close() error {
	if !body.once {
		body.once = true
		if body.release != nil {
			body.release()
		}
	}
	return body.ReadCloser.Close()
}

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

// ControlledTextFromContent reads the text one content part carries.
func ControlledTextFromContent(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case []any:
		var b strings.Builder
		for _, item := range typed {
			b.WriteString(ControlledTextFromContent(item))
		}
		return b.String()
	case map[string]any:
		if text, ok := typed["text"].(string); ok {
			return text
		}
		if thinking, ok := typed["thinking"].(string); ok {
			return thinking
		}
		if partial, ok := typed["partial_json"].(string); ok {
			return partial
		}
		if input, present := typed["input"]; present {
			encoded, err := json.Marshal(input)
			if err != nil {
				return ""
			}
			return string(encoded)
		}
		if content, ok := typed["content"].(string); ok {
			return content
		}
	}
	return ""
}
