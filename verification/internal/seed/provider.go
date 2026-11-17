package seed

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

type Step struct {
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
	Text      string         `json:"text"`
}

type Script struct {
	Steps []Step `json:"steps"`
	Final string `json:"final"`
}

type chatMessage struct {
	Role      string          `json:"role"`
	Content   json.RawMessage `json:"content"`
	ToolCalls []toolCall      `json:"tool_calls"`
}

type toolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type chatRequest struct {
	Messages []chatMessage `json:"messages"`
	Tools    []struct {
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	} `json:"tools"`
}

type Provider struct {
	BaseURL  string
	listener net.Listener
	server   *http.Server
	mu       sync.Mutex
	requests int
	answers  []string
	script   Script
}

func StartProvider(script Script) (*Provider, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	provider := &Provider{listener: listener, script: script}
	provider.BaseURL = "http://" + listener.Addr().String() + "/v1"
	mux := http.NewServeMux()
	mux.HandleFunc("/", provider.handle)
	provider.server = &http.Server{Handler: mux}
	go func() { _ = provider.server.Serve(listener) }()
	return provider, nil
}

func (p *Provider) Close() error {
	if p == nil || p.server == nil {
		return nil
	}
	return p.server.Close()
}

func (p *Provider) Requests() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.requests
}

func (p *Provider) Answers() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	answers := append([]string(nil), p.answers...)
	return answers
}

func (p *Provider) handle(writer http.ResponseWriter, request *http.Request) {
	payload, err := io.ReadAll(request.Body)
	if err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	var body chatRequest
	if err := json.Unmarshal(payload, &body); err != nil {
		http.Error(writer, err.Error(), http.StatusBadRequest)
		return
	}
	step, text := p.decide(body)
	p.mu.Lock()
	p.requests++
	if step == nil {
		p.answers = append(p.answers, text)
	}
	p.mu.Unlock()

	delta := map[string]any{"role": "assistant"}
	finishReason := "stop"
	if step != nil {
		arguments, marshalErr := json.Marshal(step.Arguments)
		if marshalErr != nil {
			arguments = []byte("{}")
		}
		delta["tool_calls"] = []map[string]any{{
			"index": 0,
			"id":    "seed-step",
			"type":  "function",
			"function": map[string]any{
				"name":      step.Tool,
				"arguments": string(arguments),
			},
		}}
		finishReason = "tool_calls"
	} else {
		delta["content"] = text
	}

	writer.Header().Set("content-type", "text/event-stream")
	writer.WriteHeader(http.StatusOK)
	first, _ := json.Marshal(map[string]any{
		"id": "seed", "object": "chat.completion.chunk", "created": 1, "model": "seed",
		"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": nil}},
	})
	_, _ = writer.Write([]byte("data: " + string(first) + "\n\n"))
	last, _ := json.Marshal(map[string]any{
		"id":      "seed",
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{}, "finish_reason": finishReason}},
		"usage":   map[string]any{"prompt_tokens": 40, "completion_tokens": 10},
	})
	_, _ = writer.Write([]byte("data: " + string(last) + "\n\n"))
	_, _ = writer.Write([]byte("data: [DONE]\n\n"))
}

func (p *Provider) decide(body chatRequest) (*Step, string) {
	p.mu.Lock()
	script := p.script
	p.mu.Unlock()
	done := 0
	for _, message := range body.Messages {
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			done++
		}
	}
	if done < len(script.Steps) {
		step := script.Steps[done]
		if step.Tool != "" && p.offered(body, step.Tool) {
			return &step, ""
		}
		if step.Text != "" {
			return nil, step.Text
		}
	}
	if script.Final != "" {
		return nil, script.Final
	}
	return nil, "完成。"
}

func (p *Provider) offered(body chatRequest, tool string) bool {
	if len(body.Tools) == 0 {
		return true
	}
	for _, candidate := range body.Tools {
		if candidate.Function.Name == tool {
			return true
		}
	}
	return false
}

func messageText(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		return text
	}
	var parts []struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		collected := make([]string, 0, len(parts))
		for _, part := range parts {
			collected = append(collected, part.Text)
		}
		return strings.Join(collected, "\n")
	}
	return string(raw)
}
