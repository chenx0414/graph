package graph

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
)

// WorkerRequests handles one worker operation and can cancel a model or tool target.
type WorkerRequests struct {
	Call   func(value any) any
	Cancel func(target string) bool
	// Ready receives the worker's session identity once its session is open.
	Ready func(inspect any)
}

// CreateWorkerRequests selects capability targets and model credentials on the host.
func CreateWorkerRequests(options struct {
	Broker    *CallBroker
	Model     any
	Stream    PromptStreamFunc
	Resources map[string]struct {
		URL     string
		Headers map[string]string
	}
	Tools                 map[string]func(id string, params map[string]any, signal context.Context) any
	AllowedNativeTools    []string
	AllowedExtensionTools []string
	OnEvent               func(event any)
}) *WorkerRequests {
	toolAborts := map[string]context.CancelFunc{}
	modelAborts := map[string]context.CancelFunc{}
	requests := &WorkerRequests{}
	call := func(value any) any {
		// The request is read as it arrived: a plain map round-trip would drop the
		// order of the system prompt sections the transcript carries.
		request, ok := value.(map[string]any)
		if !ok {
			panic(errors.New("Invalid worker request"))
		}
		operation := mapString(request, "operation")
		if operation == "ready" {
			// The worker announces its session identity before it accepts a
			// prompt. The host keeps it so the instance manifest can name the
			// session the turn really used.
			if requests.Ready != nil {
				requests.Ready(request["inspect"])
			}
			return nil
		}
		if operation == "compaction_result" {
			return nil
		}
		if operation == "model" {
			target := mapString(request, "target")
			ctx, cancel := context.WithCancel(context.Background())
			if target != "" {
				modelAborts[target] = cancel
			} else {
				defer cancel()
			}
			defer func() {
				if target != "" {
					if modelAborts[target] != nil {
						delete(modelAborts, target)
					}
				}
			}()
			var modelContext map[string]any
			if prompt, ok := request["prompt"].(string); ok && len(prompt) <= 100000 {
				modelContext = map[string]any{"messages": []any{map[string]any{"role": "user", "content": prompt, "timestamp": NowMillis()}}}
			} else {
				candidate, isContext := request["context"].(map[string]any)
				if !isContext {
					panic(errors.New("Invalid model context"))
				}
				messages, hasMessages := candidate["messages"].([]any)
				if !hasMessages {
					panic(errors.New("Invalid model context"))
				}
				modelContext = map[string]any{"messages": messages}
				if system, ok := candidate["systemPrompt"].(string); ok {
					modelContext["systemPrompt"] = system
				}
				if tools, ok := candidate["tools"].([]any); ok {
					modelContext["tools"] = tools
				}
			}
			streamOptions := map[string]any{}
			if existing := asMap(WorkerModelOptionsOf(request["options"])); existing != nil {
				for key, value := range existing {
					streamOptions[key] = value
				}
			}
			streamOptions["signal"] = map[string]any{"aborted": false, "context": ctx}
			stream, err := options.Stream(options.Model, controlledNormalizeContext(modelContext), streamOptions)
			if err != nil {
				panic(err)
			}
			if request["events"] == true {
				frames := EncodeAssistantStream(stream)
				return map[string]any{"frames": frames, "settlement": stream.Result()}
			}
			return stream.Result()
		}
		if operation == "event" {
			if options.OnEvent != nil {
				options.OnEvent(request["event"])
			}
			return nil
		}
		if operation == "tool" {
			name := mapString(request, "name")
			if name == "" {
				panic(errors.New("Invalid tool name"))
			}
			tool := options.Tools[name]
			if tool == nil {
				panic(errors.New("Tool not granted: " + name))
			}
			params := asMap(request["args"])
			if params == nil {
				params = map[string]any{}
			}
			id := ""
			if text, ok := request["id"].(string); ok {
				id = text
			} else if request["id"] != nil {
				id = strings.Trim(stringifyJSON(request["id"]), "\"")
			}
			ctx, cancel := context.WithCancel(context.Background())
			if id != "" {
				toolAborts[id] = cancel
			} else {
				defer cancel()
			}
			defer func() {
				if id != "" {
					delete(toolAborts, id)
				}
			}()
			value := tool(id, params, ctx)
			// A refusal is an answer the model reads, not a transport failure.
			// The worker only understands tool results, so the reason travels
			// as one instead of as a bare error.
			if failure, ok := value.(error); ok {
				return agentToolsFailure(failure)
			}
			return value
		}
		if operation == "tool_gate" {
			name := mapString(request, "name")
			if name == "" {
				panic(errors.New("Invalid tool name"))
			}
			native := false
			for _, item := range options.AllowedNativeTools {
				if item == name {
					native = true
					break
				}
			}
			extension := false
			for _, item := range options.AllowedExtensionTools {
				if item == name {
					extension = true
					break
				}
			}
			if !native && !extension {
				return map[string]any{"allowed": false, "reason": "Tool " + name + " is not enabled for this Agent operation"}
			}
			id := graphUUID()
			func() {
				defer func() {
					if rec := recover(); rec != nil {
						panic(workerGateError{reason: errorText(rec)})
					}
				}()
				options.Broker.Dispatch(id, 0, func() any { return nil })
				options.Broker.Settle(id, &TokenUsage{})
			}()
			return map[string]any{"allowed": true}
		}
		if operation == "read" {
			resourceName, ok := request["resource"].(string)
			if !ok {
				panic(errors.New("Operation not granted"))
			}
			resource, ok := options.Resources[resourceName]
			if !ok {
				panic(errors.New("Resource not granted"))
			}
			id := graphUUID()
			response := options.Broker.Dispatch(id, 0, func() any {
				req, err := http.NewRequest(http.MethodGet, resource.URL, nil)
				if err != nil {
					panic(err)
				}
				for key, value := range resource.Headers {
					req.Header.Set(key, value)
				}
				client := *HTTPClient
				client.CheckRedirect = func(*http.Request, []*http.Request) error {
					return errors.New("redirect")
				}
				resp, err := client.Do(req)
				if err != nil {
					panic(err)
				}
				return resp
			})
			defer options.Broker.Settle(id, &TokenUsage{})
			resp, _ := response.(*http.Response)
			if resp == nil {
				panic(errors.New("Read failed: 0"))
			}
			defer resp.Body.Close()
			if resp.StatusCode < 200 || resp.StatusCode >= 300 {
				panic(errors.New("Read failed: " + itoa(resp.StatusCode)))
			}
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				panic(err)
			}
			return string(body)
		}
		panic(errors.New("Operation not granted"))
	}
	wrapped := func(value any) (result any) {
		defer func() {
			if rec := recover(); rec != nil {
				if gate, ok := rec.(workerGateError); ok {
					result = map[string]any{"allowed": false, "reason": gate.reason}
					return
				}
				panic(rec)
			}
		}()
		return call(value)
	}
	requests.Call = wrapped
	requests.Cancel = func(target string) bool {
		if cancel, ok := modelAborts[target]; ok {
			cancel()
			return true
		}
		cancel, ok := toolAborts[target]
		if !ok {
			return false
		}
		cancel()
		return true
	}
	return requests
}

type workerGateError struct{ reason string }

func errorText(rec any) string {
	if err, ok := rec.(error); ok {
		return err.Error()
	}
	return stringifyJSON(rec)
}
