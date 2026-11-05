package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"context"
)

// controlledToolCall is the tool call one provider stream is building.
type controlledToolCall struct {
	id        string
	name      string
	arguments strings.Builder
}

// controlledStream is one controlled provider send.
type controlledStream struct {
	broker         SendGate
	candidate      ModelEntry
	resolveKey     func(candidate ModelEntry) string
	slot           func(candidate ModelEntry) *piAdapterSlot
	api            ModelApi
	usageOptions   PiAdapterStreamOptions
	model          map[string]any
	context        map[string]any
	options        map[string]any
	toolCalls      map[int]*controlledToolCall
	toolCallBlocks map[int]int
	message        *AssistantMessage
	events         []map[string]any
	index          int
	finished       bool
	settled        bool
	invocation     string
	finishReason   string
	// transport is set when the send failed at the provider boundary before any
	// answer byte arrived: such a failure may be taken over by the model's
	// configured fallback, and it is settled as producing no usage.
	transport bool
	// cancelRequest ends the provider request. It is called when the provider
	// stops answering: the connection is still open then, and everything that
	// reads the rest of it would wait for the provider to stop talking.
	cancelRequest func()
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
//
// One send is tried again on a fresh connection when it died before any answer
// byte arrived: nothing of it reached the transcript, so nothing that already
// happened runs twice. The retries belong to this one send, inside the same
// durable submission - the operation, the user's message and the tool results
// already in the transcript stay what they were.
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
	for attempt := 1; ; attempt++ {
		// A request body is a stream: the first attempt drains it, so a replay
		// needs the same bytes again.
		if attempt > 1 {
			body, bodyErr := request.GetBody()
			if bodyErr != nil {
				stream.fail(bodyErr)
				return
			}
			request.Body = body
			// The connection that died is not the one to dial again.
			request.Close = true
		}
		failure := stream.attempt(request, reservation, TRANSPORT_RETRIES-(attempt-1))
		if failure == nil {
			return
		}
		// What a person reading the timeline must see before the replay: how
		// long the transport waits, and why the attempt produced nothing.
		delay := transportRetryBackoffMs(attempt)
		stream.observeReconnect(attempt, delay, failure)
		stream.discardAttempt()
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
}

// attempt sends the request once and reads what the provider answered.
//
// It returns the failure the same send must be tried again after, or nil when
// the attempt settled the stream - with an answer, or with the failure the turn
// ends on. remaining is the retry budget the attempt may still spend: an
// attempt that will be replayed settles as producing no usage instead of
// leaving an unknown call behind that refuses the next send.
func (stream *controlledStream) attempt(request *http.Request, reservation float64, remaining int) error {
	ctx, cancelRequest := context.WithCancel(request.Context())
	stream.cancelRequest = cancelRequest
	request = request.WithContext(ctx)
	transport, err := ControlledGatedProviderFetch(stream.broker, request, GatedProviderFetchOptions{
		Reservation:     reservation,
		RequestIDHeader: controlledRequestIDHeader(stream.candidate),
		// A send with a fallback may be taken over: an attempt that produced no
		// answer must not leave an unknown call behind that refuses the fallback.
		ReclaimUnanswered: stream.usageOptions.HasFallback,
		OnTransport:       stream.usageOptions.OnTransport,
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
		stream.failTransport(err)
		return nil
	}
	if transport.StatusCode < 200 || transport.StatusCode >= 300 {
		transport.Body.Close()
		if stream.usageOptions.HasFallback {
			// Nothing was answered, so the call produced no usage - and the
			// fallback's own send must not be refused as a send after an unknown
			// one. Without a fallback the attempt keeps its unknown usage.
			stream.settle(&controlledZeroUsage)
		} else {
			stream.broker.Settle(stream.invocation, nil)
		}
		stream.failTransport(fmt.Errorf("Provider answered HTTP %d", transport.StatusCode))
		return nil
	}
	return stream.readEvents(transport, remaining)
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
			// The system prompt is the first thing every request of the
			// session repeats, so it is the first thing worth keeping.
			body["system"] = []any{map[string]any{
				"type": "text", "text": system, "cache_control": controlledAnthropicCacheControl(),
			}}
		}
		messages := controlledAnthropicMessages(transcript)
		messages = controlledAnthropicCachedMessages(messages)
		body["messages"] = messages
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
			body["tools"] = controlledAnthropicCachedTools(tools)
		}
	case "openai-responses":
		endpoint += "/responses"
		body["model"] = modelID
		body["stream"] = true
		// The transcript travels every turn: the provider keeps nothing, so no
		// stored response id can go missing between two requests.
		body["store"] = false
		if instructions := controlledSystemPrompt(stream.context); instructions != "" {
			body["instructions"] = instructions
		}
		body["input"] = controlledResponsesInput(transcript)
		if tokens := ControlledMaxTokens(record, stream.options); tokens > 0 {
			body["max_output_tokens"] = tokens
		}
		if tools := controlledResponsesTools(transcript); len(tools) > 0 {
			body["tools"] = tools
		}
		if reasoning := controlledResponsesReasoning(record, stream.options); reasoning != nil {
			body["reasoning"] = reasoning
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
