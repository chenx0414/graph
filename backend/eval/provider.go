package eval

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"sync"
)

type scriptStep struct {
	Tool      string
	Arguments map[string]any
}

type scriptedProvider struct {
	server   *http.Server
	listener net.Listener
	BaseURL  string
	mutex    sync.Mutex
	steps    []scriptStep
	requests int
	answers  []string
}

func startScriptedProvider(steps []scriptStep) (*scriptedProvider, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	provider := &scriptedProvider{listener: listener, steps: steps}
	provider.BaseURL = "http://" + listener.Addr().String() + "/v1"
	mux := http.NewServeMux()
	mux.HandleFunc("/", provider.handle)
	provider.server = &http.Server{Handler: mux}
	go func() { _ = provider.server.Serve(listener) }()
	return provider, nil
}

func (provider *scriptedProvider) Close() {
	if provider != nil && provider.server != nil {
		_ = provider.server.Close()
	}
}

func (provider *scriptedProvider) Requests() int {
	provider.mutex.Lock()
	defer provider.mutex.Unlock()
	return provider.requests
}

type providerMessage struct {
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	ToolCalls []struct {
		ID string `json:"id"`
	} `json:"tool_calls"`
}

type providerRequest struct {
	Messages []providerMessage `json:"messages"`
}

func (provider *scriptedProvider) handle(writer http.ResponseWriter, request *http.Request) {
	payload, err := io.ReadAll(request.Body)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	var body providerRequest
	_ = json.Unmarshal(payload, &body)
	done := 0
	for _, message := range body.Messages {
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			done++
		}
	}
	provider.mutex.Lock()
	provider.requests++
	step := scriptStep{}
	hasStep := done < len(provider.steps)
	if hasStep {
		step = provider.steps[done]
	}
	provider.mutex.Unlock()

	delta := map[string]any{"role": "assistant"}
	finish := "stop"
	if hasStep {
		arguments, _ := json.Marshal(step.Arguments)
		delta["tool_calls"] = []map[string]any{{
			"index": 0,
			"id":    fmt.Sprintf("eval-step-%d", done),
			"type":  "function",
			"function": map[string]any{
				"name": step.Tool, "arguments": string(arguments),
			},
		}}
		finish = "tool_calls"
	} else {
		text := "the requested work is complete"
		delta["content"] = text
		provider.mutex.Lock()
		provider.answers = append(provider.answers, text)
		provider.mutex.Unlock()
	}
	writer.Header().Set("content-type", "text/event-stream")
	writer.WriteHeader(http.StatusOK)
	first, _ := json.Marshal(map[string]any{
		"id": "response", "object": "chat.completion.chunk", "created": 1, "model": "local",
		"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": nil}},
	})
	_, _ = fmt.Fprintf(writer, "data: %s\n\n", first)
	last, _ := json.Marshal(map[string]any{
		"id": "response", "model": "local",
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{}, "finish_reason": finish}},
		"usage":   map[string]any{"prompt_tokens": 40, "completion_tokens": 10},
	})
	_, _ = fmt.Fprintf(writer, "data: %s\n\n", last)
	_, _ = io.WriteString(writer, "data: [DONE]\n\n")
}

func providerConfig(project, baseURL string) string {
	return fmt.Sprintf(`{"version":1,"projects":[{"id":"p","root":%q}],`+
		`"credentials":{"local":{"secretRef":"GRAPH_EVAL_LOCAL_KEY"}},`+
		`"models":{"entries":[{"id":"local","modelId":"local","provider":"graph-openai","grade":"high",`+
		`"api":"openai-completions","baseUrl":%q,"contextWindow":32000,"maxTokens":256,`+
		`"credentialId":"local","cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0}}]}}`, project, baseURL)
}
