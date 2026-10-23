package graph

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"

	"github.com/chenx0414/graph/backend/internal/pigkernel"
)

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
			toolCalls: map[int]*controlledToolCall{}, toolCallBlocks: map[int]int{},
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
		Reservation: reservation,
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
	// The caller may ask for less room than the model's own limit: a summary asks
	// for a bounded handoff, and a provider that is asked for the model's whole
	// limit answers with as much as it can and runs out of room.
	limit := int64(0)
	if requested, ok := controlledSafeCount(stream.options[pigkernel.MaxTokensOption]); ok && requested > 0 {
		limit = requested
	} else if tokens, ok := controlledSafeCount(record["maxTokens"]); ok && tokens > 0 {
		limit = tokens
	}
	switch stream.api {
	case "anthropic-messages":
		endpoint += "/messages"
		body["model"] = modelID
		body["stream"] = true
		if system := controlledSystemPrompt(stream.context); system != "" {
			body["system"] = controlledAnthropicSystem(system)
		}
		body["messages"] = controlledAnthropicCachedMessages(controlledAnthropicMessages(transcript))
		if limit > 0 {
			body["max_tokens"] = limit
		}
		if tools := controlledAnthropicTools(transcript); len(tools) > 0 {
			body["tools"] = controlledAnthropicCachedTools(tools)
		}
	default:
		endpoint += "/chat/completions"
		body["model"] = modelID
		body["stream"] = true
		body["stream_options"] = map[string]any{"include_usage": true}
		body["messages"] = controlledOpenAIMessages(transcript, controlledInstructionRole(record))
		if limit > 0 {
			body["max_tokens"] = limit
		}
		if tools := controlledOpenAITools(transcript); len(tools) > 0 {
			body["tools"] = tools
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
