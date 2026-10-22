package graph

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sort"
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
	// OnTransport observes every provider attempt after admission: what left, what came
	// back and how it failed.
	OnTransport func(observation ProviderTransportObservation)
	// RequestIDHeader names the correlation header the provider may forward.
	RequestIDHeader string
}

// controlledZeroUsage is the settlement of a send that produced no tokens.
var controlledZeroUsage = TokenUsage{Input: 0, Output: 0, CacheRead: 0, CacheWrite: 0, UsageSource: stringPointer(string(UsageAuthoritative))}

// controlledRetryableTransportCodes are the transport failures that prove nothing was sent.
var controlledRetryableTransportCodes = map[string]bool{
	"ECONNREFUSED":            true,
	"ENOTFOUND":               true,
	"UND_ERR_CONNECT_TIMEOUT": true,
}

// stringPointer reads one text as an optional value.
func stringPointer(value string) *string {
	return &value
}

// ControlledProviderUsage parses the usage one provider reported.
func ControlledProviderUsage(value any, api ModelApi) *TokenUsage {
	if api == "anthropic-messages" {
		return controlledAnthropicUsage(value)
	}
	return controlledOpenAIUsage(value)
}

// controlledOpenAIUsage parses one OpenAI usage object.
func controlledOpenAIUsage(value any) *TokenUsage {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input, inputOK := controlledSafeCount(raw["prompt_tokens"])
	output, outputOK := controlledSafeCount(raw["completion_tokens"])
	cache := int64(0)
	if details, ok := raw["prompt_tokens_details"].(map[string]any); ok {
		if count, ok := controlledSafeCount(details["cached_tokens"]); ok {
			cache = count
		}
	}
	if cache == 0 {
		if count, ok := controlledSafeCount(raw["prompt_cache_hit_tokens"]); ok {
			cache = count
		} else if count, ok := controlledSafeCount(raw["cached_tokens"]); ok {
			cache = count
		}
	}
	if !inputOK || !outputOK {
		return nil
	}
	if cache > input {
		return nil
	}
	if total, present := raw["total_tokens"]; present && total != nil {
		count, ok := controlledSafeCount(total)
		if !ok || count != input+output {
			return nil
		}
	}
	return &TokenUsage{Input: input - cache, Output: output, CacheRead: cache, CacheWrite: 0, UsageSource: stringPointer(string(UsageAuthoritative))}
}

// controlledAnthropicUsage parses one Anthropic usage object.
func controlledAnthropicUsage(value any) *TokenUsage {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	input, inputOK := controlledSafeCount(raw["input_tokens"])
	output, outputOK := controlledSafeCount(raw["output_tokens"])
	cacheReadValue := raw["cache_read_input_tokens"]
	if cacheReadValue == nil {
		cacheReadValue = float64(0)
	}
	cacheRead, cacheReadOK := controlledSafeCount(cacheReadValue)
	cacheWriteValue := raw["cache_creation_input_tokens"]
	if cacheWriteValue == nil {
		cacheWriteValue = float64(0)
	}
	cacheWrite, cacheWriteOK := controlledSafeCount(cacheWriteValue)
	if !inputOK || !outputOK || !cacheReadOK || !cacheWriteOK {
		return nil
	}
	return &TokenUsage{Input: input, Output: output, CacheRead: cacheRead, CacheWrite: cacheWrite, UsageSource: stringPointer(string(UsageAuthoritative))}
}

// controlledSafeCount reads one nonnegative integer count.
func controlledSafeCount(value any) (int64, bool) {
	switch typed := value.(type) {
	case float64:
		if typed < 0 || typed != float64(int64(typed)) || !jsSafeInteger(typed) {
			return 0, false
		}
		return int64(typed), true
	case int:
		return int64(typed), true
	case int64:
		return typed, true
	case json.Number:
		number, err := typed.Int64()
		if err != nil || number < 0 {
			return 0, false
		}
		return number, true
	}
	return 0, false
}

// ControlledReadUsage reads the usage one provider response carries.
func ControlledReadUsage(response *http.Response, api ModelApi) *TokenUsage {
	// A bounded clone observes raw evidence; an SDK's zero-filled error is not evidence.
	if response == nil || response.Body == nil {
		return nil
	}
	contentType := response.Header.Get("content-type")
	body, err := io.ReadAll(io.LimitReader(response.Body, 8_000_001))
	response.Body.Close()
	if err != nil {
		return nil
	}
	if len(body) > 8_000_000 {
		return nil
	}
	if strings.Contains(contentType, "application/json") {
		var decoded map[string]any
		if err := json.Unmarshal(body, &decoded); err != nil {
			return nil
		}
		return ControlledProviderUsage(decoded["usage"], api)
	}
	evidence := controlledUsageEvidence{}
	for _, line := range strings.Split(string(body), "\n") {
		if evidence.feed(line, api) {
			return evidence.result(api)
		}
	}
	return evidence.result(api)
}

type controlledUsageEvidence struct {
	usage    *TokenUsage
	complete bool
	terminal bool
}

func (evidence *controlledUsageEvidence) result(api ModelApi) *TokenUsage {
	if api == "anthropic-messages" && (!evidence.complete || !evidence.terminal) {
		return nil
	}
	return evidence.usage
}
func (evidence *controlledUsageEvidence) feed(line string, api ModelApi) bool {
	if !strings.HasPrefix(line, "data:") {
		return false
	}
	payload := strings.TrimSpace(line[5:])
	if payload == "" {
		return false
	}
	if api == "openai-completions" && payload == "[DONE]" {
		evidence.terminal = true
		return true
	}
	var event map[string]any
	if json.Unmarshal([]byte(payload), &event) != nil {
		return false
	}
	if api == "anthropic-messages" {
		switch rsiText(event["type"]) {
		case "message_start":
			evidence.usage = controlledAnthropicUsage(asMap(event["message"])["usage"])
			evidence.complete = false
		case "message_delta":
			if evidence.usage != nil {
				base := evidence.usage
				delta := map[string]any{"input_tokens": float64(base.Input), "cache_read_input_tokens": float64(base.CacheRead), "cache_creation_input_tokens": float64(base.CacheWrite)}
				for key, value := range asMap(event["usage"]) {
					delta[key] = value
				}
				evidence.usage = controlledAnthropicUsage(delta)
				evidence.complete = evidence.usage != nil
			}
		case "message_stop":
			evidence.terminal = true
			return true
		}
	} else if event["usage"] != nil {
		evidence.usage = controlledOpenAIUsage(event["usage"])
	}
	return false
}

// ControlledIsTerminalSseLine reports whether one SSE line ends the event stream.
func ControlledIsTerminalSseLine(line string) bool {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "data:") {
		return false
	}
	payload := strings.TrimSpace(trimmed[5:])
	if payload == "[DONE]" {
		return true
	}
	var event map[string]any
	if err := json.Unmarshal([]byte(payload), &event); err != nil {
		return false
	}
	return event["type"] == "message_stop"
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

// ControlledOpenAIStream is the controlled lower-level adapter, verified for the OpenAI
// chat-completions and Anthropic messages streams.
//
// The provider HTTP API is the boundary: the Pi SDK is not linked here, so the request is built
// and the event stream is parsed by this adapter.
//
// The candidate is the Graph model entry this send belongs to. The credential and the slot are
// resolved against it, never against the provider-shaped model the SDK carries: that one names
// the provider model, so a lookup by it would miss the configured entry and its credential.
func ControlledOpenAIStream(broker SendGate, candidate ModelEntry, resolveKey func(candidate ModelEntry) string, slot func(candidate ModelEntry) *piAdapterSlot, api ModelApi, usageOptions PiAdapterStreamOptions) PromptStreamFunc {
	if api != "openai-completions" && api != "anthropic-messages" {
		panic(errors.New("Unverified model transport"))
	}
	return func(model any, context map[string]any, options map[string]any) (ModelEventStream, error) {
		record := asMap(model)
		if headers := ModelRequestHeaders(candidate); headers != nil {
			record["headers"] = headers
		}
		stream := &controlledStream{
			broker: broker, candidate: candidate, resolveKey: resolveKey, slot: slot, api: api, usageOptions: usageOptions,
			// The transcript is the only provider-facing shape: the plain system prompt
			// field and the plain tool list are folded into the leading system message
			// first, the way the SDK's normalizeContext does it.
			model: record, context: controlledNormalizeContext(context), options: options,
			toolCalls: map[int]*controlledToolCall{}, toolBlocks: map[int]int{},
		}
		return stream, nil
	}
}

// controlledToolCall is the tool call one provider stream is building.
type controlledToolCall struct {
	id        string
	name      string
	arguments strings.Builder
}

// controlledStream is one controlled provider send.
type controlledStream struct {
	broker       SendGate
	candidate    ModelEntry
	resolveKey   func(candidate ModelEntry) string
	slot         func(candidate ModelEntry) *piAdapterSlot
	api          ModelApi
	usageOptions PiAdapterStreamOptions
	model        map[string]any
	context      map[string]any
	options      map[string]any
	toolCalls    map[int]*controlledToolCall
	toolBlocks   map[int]int
	message      *AssistantMessage
	events       []map[string]any
	index        int
	finished     bool
	settled      bool
	invocation   string
	finishReason string
}

// Next returns the next event of the provider stream.
func (stream *controlledStream) Next() (map[string]any, bool) {
	if stream.index < len(stream.events) {
		event := stream.events[stream.index]
		stream.index++
		return event, true
	}
	if stream.finished {
		return nil, false
	}
	stream.finished = true
	stream.run()
	if stream.index < len(stream.events) {
		event := stream.events[stream.index]
		stream.index++
		return event, true
	}
	return nil, false
}

// Result returns the terminal message of the provider stream.
func (stream *controlledStream) Result() map[string]any {
	for {
		if _, ok := stream.Next(); !ok {
			break
		}
	}
	if stream.message == nil {
		return map[string]any{}
	}
	return asMap(stream.message)
}

// run sends the request and reads the provider stream.
func (stream *controlledStream) run() {
	record := stream.model
	if text, ok := record["api"].(string); ok && text != "" && text != string(stream.api) {
		stream.fail(errors.New("Unverified model transport"))
		return
	}
	request, err := stream.buildRequest()
	if err != nil {
		stream.fail(err)
		return
	}
	reservation := float64(0)
	if window, ok := controlledSafeCount(record["contextWindow"]); ok {
		reservation = float64(window)
	}
	if tokens, ok := controlledSafeCount(record["maxTokens"]); ok {
		reservation += float64(tokens)
	}
	transport, err := ControlledGatedProviderFetch(stream.broker, request, GatedProviderFetchOptions{
		Reservation:     reservation,
		RequestIDHeader: controlledRequestIDHeader(stream.candidate),
		OnTransport:     stream.usageOptions.OnTransport,
		FetchImpl: func(request *http.Request) (*http.Response, error) {
			if stream.resolveKey != nil {
				headers := ModelRequestHeaders(stream.candidate)
				explicit := func(name string) bool {
					for key := range headers {
						if strings.EqualFold(key, name) {
							return true
						}
					}
					return false
				}
				key := stream.resolveKey(stream.entry())
				if stream.api == "anthropic-messages" {
					if !explicit("x-api-key") {
						request.Header.Set("x-api-key", key)
					}
				} else if !explicit("authorization") {
					request.Header.Set("authorization", "Bearer "+key)
				}
			}
			return HTTPClient.Do(request)
		},
		AcquireSlot: func() func() {
			holder := stream.acquireSlot()
			if holder == nil {
				return func() {}
			}
			return holder
		},
		OnRequest: func(id string) {
			stream.invocation = id
			if stream.usageOptions.OnRequest == nil {
				return
			}
			profile := ProfileProviderRequest(string(requestBodyOf(request)))
			if profile == nil {
				return
			}
			stream.usageOptions.OnRequest(id, asMap(profile))
		},
	})
	if err != nil {
		stream.fail(err)
		return
	}
	if transport.StatusCode < 200 || transport.StatusCode >= 300 {
		transport.Body.Close()
		stream.fail(fmt.Errorf("Provider answered HTTP %d", transport.StatusCode))
		return
	}
	stream.readEvents(transport)
}

// acquireSlot takes one host-wide concurrency slot for this send.
func (stream *controlledStream) acquireSlot() func() {
	if stream.slot == nil {
		return nil
	}
	holder := stream.slot(stream.entry())
	if holder == nil {
		return nil
	}
	release, err := holder.acquire(stream.signal())
	if err != nil {
		panic(err)
	}
	return release
}

// entry is the model entry one send uses.
func (stream *controlledStream) entry() ModelEntry {
	return stream.candidate
}

// signal is the abort signal one send carries.
func (stream *controlledStream) signal() *AbortSignal {
	if stream.options == nil {
		return nil
	}
	record := asMap(stream.options["signal"])
	if record == nil {
		return nil
	}
	signal := NewAbortSignal()
	if record["aborted"] == true {
		signal.Abort()
	}
	return signal
}

// requestBodyOf reads the body one request carries.
func requestBodyOf(request *http.Request) []byte {
	if request == nil || request.GetBody == nil {
		return nil
	}
	body, err := request.GetBody()
	if err != nil {
		return nil
	}
	defer body.Close()
	content, err := io.ReadAll(body)
	if err != nil {
		return nil
	}
	return content
}

// buildRequest builds the provider request one send carries.
func (stream *controlledStream) buildRequest() (*http.Request, error) {
	record := stream.model
	baseURL, _ := record["baseUrl"].(string)
	if baseURL == "" {
		return nil, errors.New("The model has no base url")
	}
	modelID, _ := record["id"].(string)
	if modelID == "" {
		return nil, errors.New("The model has no id")
	}
	key := ""
	if stream.resolveKey != nil {
		key = stream.resolveKey(stream.entry())
	}
	body := map[string]any{}
	transcript := controlledContextMessages(stream.context)
	endpoint := strings.TrimSuffix(baseURL, "/")
	thinkingEnabled := false
	switch stream.api {
	case "anthropic-messages":
		endpoint += "/messages"
		body["model"] = modelID
		body["stream"] = true
		if system := controlledSystemPrompt(stream.context); system != "" {
			body["system"] = system
		}
		body["messages"] = controlledAnthropicMessages(transcript)
		// Anthropic is asked for a budget of thinking tokens rather than for a
		// named strength, and the ceiling it answers under grows with it.
		ceiling, thinking := ControlledAnthropicThinking(record, stream.options)
		if ceiling > 0 {
			body["max_tokens"] = ceiling
		} else if tokens, ok := controlledSafeCount(record["maxTokens"]); ok && tokens > 0 {
			body["max_tokens"] = tokens
		}
		for name, value := range thinking {
			body[name] = value
		}
		thinkingEnabled = len(thinking) > 0
		if tools := controlledAnthropicTools(transcript); len(tools) > 0 {
			body["tools"] = tools
		}
	default:
		endpoint += "/chat/completions"
		body["model"] = modelID
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
		body["messages"] = controlledOpenAIMessages(transcript, controlledInstructionRole(record))
		if tokens := ControlledMaxTokens(record, stream.options); tokens > 0 {
			body["max_tokens"] = tokens
		}
		if tools := controlledOpenAITools(transcript); len(tools) > 0 {
			body["tools"] = tools
		}
		// The thinking strength the user chose travels with the request: the
		// provider is asked to think at that level, not at whatever it defaults
		// to. A model that runs no thinking sends no effort at all.
		for name, value := range ControlledThinkingFields(record, stream.options) {
			body[name] = value
		}
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequest(http.MethodPost, endpoint, strings.NewReader(string(encoded)))
	if err != nil {
		return nil, err
	}
	request.Header.Set("content-type", "application/json")
	request.Header.Set("accept", "text/event-stream")
	headers := asMap(record["headers"])
	for name, value := range headers {
		if text, ok := value.(string); ok {
			request.Header.Set(name, text)
		}
	}
	switch stream.api {
	case "anthropic-messages":
		if _, explicit := request.Header["X-Api-Key"]; !explicit {
			request.Header.Set("x-api-key", key)
		}
		if _, explicit := request.Header["Anthropic-Version"]; !explicit {
			request.Header.Set("anthropic-version", "2023-06-01")
		}
		if thinkingEnabled {
			// Interleaved thinking is what lets a model think again between two
			// tool calls. A configuration that names its own beta wins.
			if _, explicit := request.Header["Anthropic-Beta"]; !explicit {
				request.Header.Set("anthropic-beta", "interleaved-thinking-2025-05-14")
			}
		}
	default:
		if _, explicit := request.Header["Authorization"]; !explicit {
			request.Header.Set("authorization", "Bearer "+key)
		}
	}
	if stream.usageOptions.OnSend != nil {
		stream.usageOptions.OnSend(PiAdapterSentRequest{
			SystemPrompt:     controlledSystemPromptPointer(stream.context),
			ToolDeclarations: ControlledRequestToolDeclarations(encoded),
		})
	}
	return request, nil
}

// controlledSystemPrompt reads the system prompt one context carries.
//
// The prompt is what every system message of the transcript replays to, never the plain
// field: the provider receives the replayed prompt, so the console must show that same
// text.
func controlledSystemPrompt(context map[string]any) string {
	head := controlledCurrentSystemMessage(controlledContextMessages(context))
	if head == nil || !head.present() {
		return ""
	}
	return head.text()
}

// controlledSystemPromptPointer reads the system prompt one context carries.
func controlledSystemPromptPointer(context map[string]any) *string {
	prompt := controlledSystemPrompt(context)
	if prompt == "" {
		return nil
	}
	return &prompt
}

// controlledNormalizeContext folds the system prompt and the tool set into one leading
// system message.
//
// The Pi SDK's normalizeContext is the only entry point that produces a transcript
// context, and every provider-facing call expects the result. It is idempotent: a context
// that already carries its prompt in the transcript is left alone.
func controlledNormalizeContext(context map[string]any) map[string]any {
	if context == nil {
		return nil
	}
	messages := controlledContextMessages(context)
	systemPrompt, hasPrompt := context["systemPrompt"].(string)
	tools := controlledContextTools(context)
	if (!hasPrompt || systemPrompt == "") && len(tools) == 0 {
		return map[string]any{"messages": messages}
	}
	initial := map[string]any{"role": "system", "content": systemPrompt, "timestamp": float64(0)}
	if len(tools) > 0 {
		initial["toolsAdded"] = tools
	}
	return map[string]any{"messages": append([]any{initial}, messages...)}
}

// controlledSystemMessage is the leading system message of a transcript: the current
// prompt, the prompt sections and the tools the model may call.
type controlledSystemMessage struct {
	content      string
	sections     *controlledSectionList
	tools        []any
	timestamp    any
	hasTimestamp bool
}

// present reports whether the transcript carried a system message at all.
func (head *controlledSystemMessage) present() bool {
	return head.hasTimestamp || len(head.tools) > 0
}

// text renders the system message as a complete prompt: its content followed by its
// sections.
func (head *controlledSystemMessage) text() string {
	parts := []string{head.content}
	parts = append(parts, head.sections.texts()...)
	kept := []string{}
	for _, part := range parts {
		if part != "" {
			kept = append(kept, part)
		}
	}
	return strings.Join(kept, "\n\n")
}

// controlledCurrentSystemMessage replays every system message of a transcript into the one
// leading system message that holds the current prompt and the current tools.
//
// Later content is appended to the base prompt, the sections are patched by name and the
// tools are resolved by replaying every tool delta in order.
func controlledCurrentSystemMessage(messages []any) *controlledSystemMessage {
	head := &controlledSystemMessage{sections: &controlledSectionList{values: map[string]any{}}}
	content := []string{}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if role, _ := message["role"].(string); role != "system" {
			continue
		}
		if !head.hasTimestamp {
			if timestamp, present := message["timestamp"]; present {
				head.timestamp = timestamp
				head.hasTimestamp = true
			}
		}
		text := controlledContentText(message["content"])
		if text != "" {
			content = append(content, text)
		}
		head.sections.merge(message["sections"])
	}
	head.content = strings.Join(content, "\n\n")
	head.tools = controlledCurrentTools(messages)
	return head
}

// controlledContentText joins the text blocks of one message content.
func controlledContentText(content any) string {
	switch typed := content.(type) {
	case string:
		return typed
	case []any:
		parts := []string{}
		for _, item := range typed {
			block, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if kind, _ := block["type"].(string); kind != "text" {
				continue
			}
			text, _ := block["text"].(string)
			parts = append(parts, text)
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

// controlledCurrentTools resolves the tools available after applying every transcript
// delta in order.
func controlledCurrentTools(messages []any) []any {
	names := []string{}
	values := map[string]any{}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if role, _ := message["role"].(string); role != "system" {
			continue
		}
		for _, tool := range controlledMessageTools(message["toolsRemoved"]) {
			name := controlledToolName(tool)
			if name == "" {
				continue
			}
			if _, present := values[name]; !present {
				continue
			}
			delete(values, name)
			for index, known := range names {
				if known == name {
					names = append(names[:index], names[index+1:]...)
					break
				}
			}
		}
		for _, tool := range controlledMessageTools(message["toolsAdded"]) {
			name := controlledToolName(tool)
			if name == "" {
				continue
			}
			if _, present := values[name]; !present {
				names = append(names, name)
			}
			values[name] = tool
		}
	}
	out := []any{}
	for _, name := range names {
		out = append(out, values[name])
	}
	return out
}

// controlledMessageTools reads the tool list one transcript field carries.
func controlledMessageTools(value any) []any {
	tools, _ := value.([]any)
	return tools
}

// controlledToolName reads the name of one tool declaration.
func controlledToolName(tool any) string {
	declaration, ok := tool.(map[string]any)
	if !ok {
		return ""
	}
	name, _ := declaration["name"].(string)
	return name
}

// controlledSectionList is one system message's prompt sections, in the order the
// transcript declared them.
//
// The Pi SDK writes the sections in a fixed order and the rendered prompt keeps that
// order, so the sections keep their own shape instead of a plain map.
type controlledSectionList struct {
	names  []string
	values map[string]any
}

// merge applies one section patch. A null value removes the section, a text value sets it.
func (list *controlledSectionList) merge(patch any) {
	switch typed := patch.(type) {
	case *controlledSectionList:
		for _, name := range typed.names {
			list.set(name, typed.values[name])
		}
	case map[string]any:
		names := make([]string, 0, len(typed))
		for name := range typed {
			names = append(names, name)
		}
		// TODO(port): a plain map has no insertion order, so the sections are read by name.
		sort.Strings(names)
		for _, name := range names {
			list.set(name, typed[name])
		}
	}
}

// set stores one section, keeping the position of a name that is already known.
func (list *controlledSectionList) set(name string, value any) {
	if value == nil {
		list.remove(name)
		return
	}
	if list.values == nil {
		list.values = map[string]any{}
	}
	if _, present := list.values[name]; !present {
		list.names = append(list.names, name)
	}
	list.values[name] = value
}

// remove drops one section.
func (list *controlledSectionList) remove(name string) {
	if _, present := list.values[name]; !present {
		return
	}
	delete(list.values, name)
	for index, known := range list.names {
		if known == name {
			list.names = append(list.names[:index], list.names[index+1:]...)
			break
		}
	}
}

// texts returns the section values in transcript order.
func (list *controlledSectionList) texts() []string {
	out := []string{}
	for _, name := range list.names {
		value, present := list.values[name]
		if !present || value == nil {
			continue
		}
		text, isText := value.(string)
		if !isText {
			continue
		}
		out = append(out, text)
	}
	return out
}

// controlledInstructionRole is the role the provider's instruction message carries.
//
// A reasoning model on a provider that accepts the `developer` role gets it; every
// other provider gets `system`. The SDK detects the provider's answer from its name
// and its base URL, and so does this.
func controlledInstructionRole(model map[string]any) string {
	reasoning, _ := model["reasoning"].(bool)
	if !reasoning {
		return "system"
	}
	if controlledCompatFor(model).supportsDeveloperRole {
		return "developer"
	}
	return "system"
}

// controlledCompat is what one provider accepts.
//
// A provider asked in the wrong way refuses the whole request: the instruction
// role, the way a thinking strength is asked for, and whether the plain effort
// field is understood at all. The SDK detects the provider's answer from its
// name and its base URL, and so does this: one detection, one set of rules.
type controlledCompat struct {
	// supportsDeveloperRole reports whether the provider accepts the `developer`
	// role instead of `system`.
	supportsDeveloperRole bool
	// supportsReasoningEffort reports whether the provider understands the plain
	// `reasoning_effort` field.
	supportsReasoningEffort bool
	// thinkingFormat is the way this provider is asked for a thinking strength.
	thinkingFormat string
}

// controlledCompatFor reads what the provider of one model accepts.
func controlledCompatFor(model map[string]any) controlledCompat {
	provider, _ := model["provider"].(string)
	baseURL, _ := model["baseUrl"].(string)
	modelID, _ := model["id"].(string)
	lowered := strings.ToLower(baseURL)
	isOpenRouter := provider == "openrouter" || strings.Contains(lowered, "openrouter.ai")
	isGrok := provider == "xai" || strings.Contains(lowered, "api.x.ai")
	isZai := provider == "zai" || provider == "zai-coding-cn" ||
		strings.Contains(lowered, "api.z.ai") || strings.Contains(lowered, "open.bigmodel.cn")
	isTogether := provider == "together" || strings.Contains(lowered, "api.together.ai") || strings.Contains(lowered, "api.together.xyz")
	isMoonshot := provider == "moonshotai" || provider == "moonshotai-cn" || strings.Contains(lowered, "api.moonshot.")
	isCloudflareAiGateway := provider == "cloudflare-ai-gateway" || strings.Contains(lowered, "gateway.ai.cloudflare.com")
	isNvidia := provider == "nvidia" || strings.Contains(lowered, "integrate.api.nvidia.com")
	isAntLing := provider == "ant-ling" || strings.Contains(lowered, "api.ant-ling.com")
	isDeepSeek := provider == "deepseek" || strings.Contains(lowered, "deepseek.com")
	nonStandard := isNvidia ||
		provider == "cerebras" || strings.Contains(lowered, "cerebras.ai") ||
		isGrok ||
		isTogether ||
		strings.Contains(lowered, "chutes.ai") ||
		isDeepSeek ||
		isZai ||
		isMoonshot ||
		provider == "opencode" || strings.Contains(lowered, "opencode.ai") ||
		provider == "cloudflare-workers-ai" || strings.Contains(lowered, "api.cloudflare.com") ||
		isCloudflareAiGateway ||
		isAntLing
	format := "openai"
	switch {
	case isDeepSeek:
		format = "deepseek"
	case isZai:
		format = "zai"
	case isTogether:
		format = "together"
	case isAntLing:
		format = "ant-ling"
	case isOpenRouter:
		format = "openrouter"
	}
	openRouterDeveloper := isOpenRouter &&
		(strings.HasPrefix(modelID, "anthropic/") || strings.HasPrefix(modelID, "openai/"))
	return controlledCompat{
		supportsDeveloperRole:   openRouterDeveloper || (!nonStandard && !isOpenRouter),
		supportsReasoningEffort: !isGrok && !isZai && !isMoonshot && !isTogether && !isCloudflareAiGateway && !isNvidia && !isAntLing,
		thinkingFormat:          format,
	}
}

// controlledOpenAIMessages turns a transcript into OpenAI messages.
//
// The system messages collapse into the one leading system message a chat completions
// request carries the prompt in. The instruction role is the one the provider accepts:
// a reasoning model on a standard provider gets `developer`, everything else `system`.
func controlledOpenAIMessages(messages []any, instructionRole string) []any {
	out := []any{}
	head := controlledCurrentSystemMessage(messages)
	if head.present() {
		if text := head.text(); text != "" {
			out = append(out, map[string]any{"role": instructionRole, "content": text})
		}
	}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "toolResult":
			out = append(out, map[string]any{
				"role": "tool", "tool_call_id": message["toolCallId"],
				"content": ControlledTextFromContent(message["content"]),
			})
		case "system", "developer":
			continue
		case "assistant":
			assistant, ok := controlledOpenAIAssistant(message)
			if !ok {
				continue
			}
			out = append(out, assistant)
		default:
			out = append(out, map[string]any{"role": "user", "content": ControlledTextFromContent(message["content"])})
		}
	}
	return out
}

// controlledOpenAIAssistant renders one assistant message the way the SDK does.
//
// The assistant keeps its own role: a model that reads its own tool call back as a
// user turn does not recognize the call it made, and a tool result without the
// assistant turn that asked for it is a request no provider accepts. The text is
// the content, and every tool call the message made is an OpenAI tool call.
func controlledOpenAIAssistant(message map[string]any) (map[string]any, bool) {
	text := ""
	calls := []any{}
	content, _ := message["content"].([]any)
	for _, item := range content {
		block, ok := item.(map[string]any)
		if !ok {
			continue
		}
		kind, _ := block["type"].(string)
		switch kind {
		case "text":
			if value, ok := block["text"].(string); ok {
				text += value
			}
		case "toolCall":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			if name == "" {
				continue
			}
			calls = append(calls, map[string]any{
				"id": id, "type": "function",
				"function": map[string]any{"name": name, "arguments": stringifyJSON(block["arguments"])},
			})
		}
	}
	if text == "" && len(calls) == 0 {
		// The SDK skips an assistant message that carries neither text nor a tool
		// call; an empty one is a request no provider accepts.
		return nil, false
	}
	assistant := map[string]any{"role": "assistant", "content": nil}
	if text != "" {
		assistant["content"] = text
	}
	if len(calls) > 0 {
		assistant["tool_calls"] = calls
	}
	return assistant, true
}

// controlledAnthropicMessages turns a transcript into Anthropic messages.
func controlledAnthropicMessages(messages []any) []any {
	out := []any{}
	for _, item := range messages {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		role, _ := message["role"].(string)
		switch role {
		case "toolResult":
			out = append(out, map[string]any{
				"role": "user",
				"content": []any{map[string]any{
					"type": "tool_result", "tool_use_id": message["toolCallId"],
					"content": ControlledTextFromContent(message["content"]),
				}},
			})
		case "assistant":
			out = append(out, map[string]any{"role": "assistant", "content": ControlledTextFromContent(message["content"])})
		case "system", "developer":
			continue
		default:
			out = append(out, map[string]any{"role": "user", "content": ControlledTextFromContent(message["content"])})
		}
	}
	return out
}

// controlledContextMessages reads the messages one context carries.
func controlledContextMessages(context map[string]any) []any {
	if context == nil {
		return nil
	}
	messages, _ := context["messages"].([]any)
	return messages
}

// controlledOpenAITools turns the transcript tools into OpenAI tool declarations.
func controlledOpenAITools(messages []any) []any {
	out := []any{}
	for _, tool := range controlledCurrentTools(messages) {
		declaration, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := declaration["name"].(string)
		if name == "" {
			continue
		}
		description, _ := declaration["description"].(string)
		function := map[string]any{"name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			function["parameters"] = parameters
		}
		out = append(out, map[string]any{"type": "function", "function": function})
	}
	return out
}

// controlledAnthropicTools turns the transcript tools into Anthropic tool declarations.
func controlledAnthropicTools(messages []any) []any {
	out := []any{}
	for _, tool := range controlledCurrentTools(messages) {
		declaration, ok := tool.(map[string]any)
		if !ok {
			continue
		}
		name, _ := declaration["name"].(string)
		if name == "" {
			continue
		}
		description, _ := declaration["description"].(string)
		tool := map[string]any{"name": name, "description": description}
		if parameters, present := declaration["parameters"]; present && parameters != nil {
			tool["input_schema"] = parameters
		}
		out = append(out, tool)
	}
	return out
}

// controlledContextTools reads the tool declarations one context carries.
func controlledContextTools(context map[string]any) []any {
	if context == nil {
		return nil
	}
	tools, _ := context["tools"].([]any)
	return tools
}

// fail records the failure of one send as the stream's terminal event.
func (stream *controlledStream) fail(err error) {
	message := &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: string(stream.api), Provider: providerOf(stream.model), Model: modelIDOf(stream.model),
		StopReason: "error", ErrorMessage: stringPointer(err.Error()), Timestamp: NowMillis(),
	}
	stream.message = message
	stream.events = append(stream.events, map[string]any{
		"type": "error", "reason": "error", "error": asMap(message),
	})
}

// providerOf reads the provider one model names.
func providerOf(model map[string]any) string {
	provider, _ := model["provider"].(string)
	return provider
}

// modelIDOf reads the model id one model names.
func modelIDOf(model map[string]any) string {
	id, _ := model["id"].(string)
	return id
}

// readEvents reads the provider event stream.
func (stream *controlledStream) readEvents(response *http.Response) {
	defer response.Body.Close()
	stream.message = &AssistantMessage{
		Role: "assistant", Content: []AssistantContentBlock{},
		Api: string(stream.api), Provider: providerOf(stream.model), Model: modelIDOf(stream.model),
		StopReason: "pending", Timestamp: NowMillis(),
	}
	stream.events = append(stream.events, map[string]any{"type": "start", "partial": stream.partial()})
	reader := bufio.NewReader(response.Body)
	evidence := controlledUsageEvidence{}
	for {
		line, err := reader.ReadString('\n')
		if line != "" {
			trimmed := strings.TrimRight(line, "\r\n")
			if strings.HasPrefix(trimmed, "data:") {
				payload := strings.TrimSpace(trimmed[5:])
				if payload == "[DONE]" {
					break
				}
				if payload != "" {
					var event map[string]any
					if json.Unmarshal([]byte(payload), &event) == nil {
						stream.handleEvent(event)
						evidence.feed(trimmed, stream.api)
					}
				}
			}
		}
		if evidence.terminal || err != nil {
			break
		}
	}
	usage := evidence.result(stream.api)
	if usage == nil {
		if stream.usageOptions.EstimateMissing {
			estimated := stream.estimateUsage(response)
			if estimated != nil {
				usage = estimated
			}
		}
	}
	// A provider that does not say what the call cost leaves the cost unknown.
	// It settles as no evidence at all, not as a zero-filled record: a zero
	// record is a claim that the call was free, and the ledger has to be able
	// to tell "free" apart from "not said". A gate that keeps unknown usage
	// apart is what lets the next send wait for a reconciliation.
	stream.settle(usage)
	reason := stream.finishReason
	if reason == "" {
		reason = "stop"
	}
	stream.message.StopReason = reason
	stream.events = append(stream.events, map[string]any{
		"type": "done", "reason": reason, "message": asMap(stream.message),
	})
}

// estimateUsage estimates the usage one response used when the provider reported none.
//
// TODO(port): the Pi SDK's estimateTextTokens and estimateContextTokens are not in this module.
// The byte heuristic of the request profiler is used instead.
func (stream *controlledStream) estimateUsage(response *http.Response) *TokenUsage {
	if response == nil || response.Body == nil {
		return nil
	}
	body, err := io.ReadAll(io.LimitReader(response.Body, 8_000_001))
	if err != nil {
		return nil
	}
	output := controlledEstimateTokens(string(body))
	input := controlledEstimateTokens(controlledContextText(stream.context))
	if input <= 0 && output <= 0 {
		return nil
	}
	return &TokenUsage{Input: int64(input), Output: int64(output), UsageSource: stringPointer(string(UsageEstimated))}
}

// controlledEstimateTokens estimates the tokens one text costs.
func controlledEstimateTokens(text string) int {
	if text == "" {
		return 0
	}
	return (len(text) + 3) / 4
}

// controlledContextText reads the text one context carries.
func controlledContextText(context map[string]any) string {
	var b strings.Builder
	for _, item := range controlledContextMessages(context) {
		message, ok := item.(map[string]any)
		if !ok {
			continue
		}
		b.WriteString(ControlledTextFromContent(message["content"]))
		b.WriteString("\n")
	}
	return b.String()
}

// settle records the usage one provider send produced.
func (stream *controlledStream) settle(usage *TokenUsage) {
	if stream.settled {
		return
	}
	stream.settled = true
	if stream.invocation == "" {
		return
	}
	stream.broker.Settle(stream.invocation, usage)
}

// handleEvent reads one provider event.
func (stream *controlledStream) handleEvent(event map[string]any) {
	switch stream.api {
	case "anthropic-messages":
		stream.handleAnthropicEvent(event)
	default:
		stream.handleOpenAIEvent(event)
	}
}

// handleOpenAIEvent reads one OpenAI chat-completions event.
func (stream *controlledStream) handleOpenAIEvent(event map[string]any) {
	choices, _ := event["choices"].([]any)
	for _, item := range choices {
		choice, ok := item.(map[string]any)
		if !ok {
			continue
		}
		if reason, ok := choice["finish_reason"].(string); ok && reason != "" {
			stream.finishReason = controlledOpenAIStopReason(reason)
		}
		delta, ok := choice["delta"].(map[string]any)
		if !ok {
			continue
		}
		if text, ok := delta["content"].(string); ok && text != "" {
			stream.appendText(text)
		}
		if thinking, ok := delta["reasoning_content"].(string); ok && thinking != "" {
			stream.appendThinking(thinking)
		}
		calls, _ := delta["tool_calls"].([]any)
		for _, call := range calls {
			entry, ok := call.(map[string]any)
			if !ok {
				continue
			}
			index := 0
			if number, ok := controlledSafeCount(entry["index"]); ok {
				index = int(number)
			}
			stream.appendToolCall(index, entry)
		}
	}
}

// controlledOpenAIStopReason maps one provider stop reason onto the runtime vocabulary.
func controlledOpenAIStopReason(reason string) string {
	switch reason {
	case "stop":
		return "stop"
	case "length":
		return "length"
	case "tool_calls", "function_call":
		return "toolUse"
	}
	return "stop"
}

// handleAnthropicEvent reads one Anthropic messages event.
func (stream *controlledStream) handleAnthropicEvent(event map[string]any) {
	kind, _ := event["type"].(string)
	index := 0
	if number, ok := controlledSafeCount(event["index"]); ok {
		index = int(number)
	}
	switch kind {
	case "content_block_start":
		block, _ := event["content_block"].(map[string]any)
		blockType, _ := block["type"].(string)
		switch blockType {
		case "text":
			stream.startText(index)
		case "thinking":
			stream.startThinking(index)
		case "tool_use":
			id, _ := block["id"].(string)
			name, _ := block["name"].(string)
			stream.startToolCall(index, index, id, name)
		}
	case "content_block_delta":
		delta, _ := event["delta"].(map[string]any)
		deltaType, _ := delta["type"].(string)
		switch deltaType {
		case "text_delta":
			text, _ := delta["text"].(string)
			stream.appendTextAt(index, text)
		case "thinking_delta":
			text, _ := delta["thinking"].(string)
			stream.appendThinkingAt(index, text)
		case "input_json_delta":
			text, _ := delta["partial_json"].(string)
			stream.appendToolArguments(index, text)
		}
	case "message_delta":
		delta, _ := event["delta"].(map[string]any)
		if reason, ok := delta["stop_reason"].(string); ok && reason != "" {
			stream.finishReason = controlledAnthropicStopReason(reason)
		}
	}
}

// controlledAnthropicStopReason maps one provider stop reason onto the runtime vocabulary.
func controlledAnthropicStopReason(reason string) string {
	switch reason {
	case "end_turn":
		return "stop"
	case "max_tokens":
		return "length"
	case "tool_use":
		return "toolUse"
	}
	return "stop"
}

// partial is the live message one event carries.
func (stream *controlledStream) partial() map[string]any {
	return asMap(stream.message)
}

// appendText adds text to the current text block.
func (stream *controlledStream) appendText(text string) {
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "text" {
		stream.startText(len(stream.message.Content))
		index = len(stream.message.Content) - 1
	}
	stream.appendTextAt(index, text)
}

// appendTextAt adds text to one text block.
func (stream *controlledStream) appendTextAt(index int, text string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	block := &stream.message.Content[index]
	block.Text += text
	stream.events = append(stream.events, map[string]any{
		"type": "text_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
	})
}

// startText opens one text block.
func (stream *controlledStream) startText(index int) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "text"}
	stream.events = append(stream.events, map[string]any{
		"type": "text_start", "contentIndex": index, "partial": stream.partial(),
	})
}

// appendThinking adds thinking to the current thinking block.
func (stream *controlledStream) appendThinking(text string) {
	index := len(stream.message.Content) - 1
	if index < 0 || stream.message.Content[index].Type != "thinking" {
		stream.startThinking(len(stream.message.Content))
		index = len(stream.message.Content) - 1
	}
	stream.appendThinkingAt(index, text)
}

// appendThinkingAt adds thinking to one thinking block.
func (stream *controlledStream) appendThinkingAt(index int, text string) {
	if index < 0 || index >= len(stream.message.Content) {
		return
	}
	block := &stream.message.Content[index]
	block.Thinking += text
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_delta", "contentIndex": index, "delta": text, "partial": stream.partial(),
	})
}

// startThinking opens one thinking block.
func (stream *controlledStream) startThinking(index int) {
	for len(stream.message.Content) <= index {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[index] = AssistantContentBlock{Type: "thinking"}
	stream.events = append(stream.events, map[string]any{
		"type": "thinking_start", "contentIndex": index, "partial": stream.partial(),
	})
}

// startToolCall opens one tool call block.
//
// The provider's tool-call index and the message's content index are two
// different numbers. OpenAI numbers the calls of one turn (0, 1, ...) while
// the message numbers its blocks, and a turn that reasons before it calls a
// tool has a thinking block first: using the call's own number as the block
// number would overwrite that reasoning and break the turn. Anthropic's block
// index is already the content index, so the caller says which number it
// means.
func (stream *controlledStream) startToolCall(toolIndex int, contentIndex int, id string, name string) {
	for len(stream.message.Content) <= contentIndex {
		stream.message.Content = append(stream.message.Content, AssistantContentBlock{})
	}
	stream.message.Content[contentIndex] = AssistantContentBlock{Type: "toolCall", Id: id, Name: name, Arguments: map[string]any{}}
	stream.toolCalls[toolIndex] = &controlledToolCall{id: id, name: name}
	stream.toolBlocks[toolIndex] = contentIndex
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_start", "contentIndex": contentIndex, "partial": stream.partial(),
	})
}

// startToolCallBlock opens one tool call in the next free content block.
func (stream *controlledStream) startToolCallBlock(toolIndex int, id string, name string) {
	stream.startToolCall(toolIndex, len(stream.message.Content), id, name)
}

// appendToolCall reads one OpenAI tool-call delta.
func (stream *controlledStream) appendToolCall(index int, entry map[string]any) {
	call, ok := stream.toolCalls[index]
	if !ok {
		id, _ := entry["id"].(string)
		function, _ := entry["function"].(map[string]any)
		name, _ := function["name"].(string)
		stream.startToolCallBlock(index, id, name)
		call = stream.toolCalls[index]
	}
	function, ok := entry["function"].(map[string]any)
	if !ok {
		return
	}
	if name, ok := function["name"].(string); ok && name != "" {
		call.name = name
	}
	if arguments, ok := function["arguments"].(string); ok && arguments != "" {
		stream.appendToolArguments(index, arguments)
	}
}

// appendToolArguments adds raw JSON arguments to one tool call.
func (stream *controlledStream) appendToolArguments(index int, text string) {
	call, ok := stream.toolCalls[index]
	if !ok {
		stream.startToolCallBlock(index, "", "")
		call = stream.toolCalls[index]
	}
	call.arguments.WriteString(text)
	contentIndex, known := stream.toolBlocks[index]
	if !known || contentIndex < 0 || contentIndex >= len(stream.message.Content) {
		return
	}
	stream.message.Content[contentIndex].Arguments = controlledToolArguments(call.arguments.String())
	stream.events = append(stream.events, map[string]any{
		"type": "toolcall_delta", "contentIndex": contentIndex, "delta": text, "partial": stream.partial(),
	})
}

// controlledToolArguments parses the raw JSON arguments one tool call carries.
//
// The value is kept as it is. A model may send arguments that are not an
// object at all, and the SDK's validator names that mistake and shows what it
// received - rewriting it into an empty object here would hide the mistake
// from the very place that explains it.
func controlledToolArguments(text string) any {
	return ParseStreamingJSON(text)
}
