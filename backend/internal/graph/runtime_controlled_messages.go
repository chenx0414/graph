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

type controlledToolCall struct {
	id        string
	name      string
	arguments strings.Builder
}

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
	transport bool
	abortRequested bool
	cancelRequest func()
}

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
		if attempt > 1 {
			body, bodyErr := request.GetBody()
			if bodyErr != nil {
				stream.fail(bodyErr)
				return
			}
			request.Body = body
			request.Close = true
		}
		failure := stream.attempt(request, reservation, TRANSPORT_RETRIES-(attempt-1))
		if failure == nil {
			return
		}
		if stream.abortRequested {
			stream.fail(errors.New("The turn was interrupted"))
			return
		}
		delay := transportRetryBackoffMs(attempt)
		stream.observeReconnect(attempt, delay, failure)
		stream.discardAttempt()
		time.Sleep(time.Duration(delay) * time.Millisecond)
	}
}

func (stream *controlledStream) attempt(request *http.Request, reservation float64, remaining int) error {
	ctx, cancelRequest := context.WithCancel(request.Context())
	stream.cancelRequest = cancelRequest
	request = request.WithContext(ctx)
	if abort, ok := stream.options["abort"].(<-chan struct{}); ok && abort != nil {
		go func() {
			select {
			case <-abort:
				stream.abortRequested = true
				cancelRequest()
			case <-ctx.Done():
			}
		}()
	}
	transport, err := ControlledGatedProviderFetch(stream.broker, request, GatedProviderFetchOptions{
		Reservation:     reservation,
		RequestIDHeader: controlledRequestIDHeader(stream.candidate),
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
			stream.settle(&controlledZeroUsage)
		} else {
			stream.broker.Settle(stream.invocation, nil)
		}
		stream.failTransport(fmt.Errorf("Provider answered HTTP %d", transport.StatusCode))
		return nil
	}
	return stream.readEvents(transport, remaining)
}

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

func (stream *controlledStream) entry() ModelEntry {
	return stream.candidate
}

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
			body["system"] = []any{map[string]any{
				"type": "text", "text": system, "cache_control": controlledAnthropicCacheControl(),
			}}
		}
		messages := controlledAnthropicMessages(transcript)
		messages = controlledAnthropicCachedMessages(messages)
		body["messages"] = messages
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
