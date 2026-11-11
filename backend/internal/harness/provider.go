package harness

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
)

var behaviorRules = map[string]string{
	"read":     "Use read to examine files",
	"edit":     "Use edit for precise changes",
	"evidence": "Use tool results as evidence",
}

func behaviorToolFor(rule string) string {
	switch rule {
	case "read":
		return "read"
	case "edit":
		return "edit"
	}
	return ""
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
	server   *http.Server
	listener net.Listener
	BaseURL  string

	mu       sync.Mutex
	answers  []string
	requests int
	script   Case
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

func promptText(messages []chatMessage) string {
	parts := []string{}
	for _, message := range messages {
		if message.Role != "system" && message.Role != "developer" {
			continue
		}
		parts = append(parts, messageText(message.Content))
	}
	return strings.Join(parts, "\n")
}

func offeredTools(body chatRequest) []string {
	names := []string{}
	for _, tool := range body.Tools {
		if tool.Function.Name != "" {
			names = append(names, tool.Function.Name)
		}
	}
	return names
}

func stepsDone(messages []chatMessage) int {
	done := 0
	for _, message := range messages {
		if message.Role == "assistant" && len(message.ToolCalls) > 0 {
			done++
		}
	}
	return done
}

type decision struct {
	kind      string
	tool      string
	arguments map[string]any
	reason    string
}

func decide(caseScript Case, step int, prompt string, offered []string) decision {
	if step >= len(caseScript.Steps) || step < 0 {
		return decision{kind: "answer"}
	}
	current := caseScript.Steps[step]
	if rule, known := behaviorRules[current.Rule]; known && !strings.Contains(prompt, rule) {
		return decision{kind: "blocked", reason: `the harness no longer says "` + rule + `"`}
	}
	tool := current.Tool
	if tool == "" {
		tool = behaviorToolFor(current.Rule)
	}
	if tool != "" && !contains(offered, tool) {
		return decision{kind: "blocked", reason: "the harness no longer offers the " + tool + " tool"}
	}
	return decision{kind: "call", tool: tool, arguments: current.Arguments}
}

func contains(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func StartProvider(caseScript Case) (*Provider, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, err
	}
	provider := &Provider{listener: listener}
	provider.BaseURL = "http://" + listener.Addr().String() + "/v1"
	mux := http.NewServeMux()
	mux.HandleFunc("/", provider.handle)
	provider.server = &http.Server{Handler: mux}
	go func() { _ = provider.server.Serve(listener) }()
	return provider, nil
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
	p.mu.Lock()
	p.requests++
	p.mu.Unlock()
	chosen := decide(p.caseFor(), stepsDone(body.Messages), promptText(body.Messages), offeredTools(body))
	delta := map[string]any{"role": "assistant"}
	if chosen.kind == "call" {
		arguments, marshalErr := json.Marshal(chosen.arguments)
		if marshalErr != nil {
			arguments = []byte("{}")
		}
		delta["tool_calls"] = []map[string]any{{
			"index": 0,
			"id":    fmt.Sprintf("harness-step-%d", stepsDone(body.Messages)),
			"type":  "function",
			"function": map[string]any{
				"name":      chosen.tool,
				"arguments": string(arguments),
			},
		}}
	} else {
		content := "The change is in place and verified against the result I read back."
		if chosen.kind == "blocked" {
			content = "I cannot continue: " + chosen.reason + "."
		}
		delta["content"] = content
		p.mu.Lock()
		p.answers = append(p.answers, content)
		p.mu.Unlock()
	}
	finishReason := "stop"
	if chosen.kind == "call" {
		finishReason = "tool_calls"
	}
	writer.Header().Set("content-type", "text/event-stream")
	writer.WriteHeader(http.StatusOK)
	first, _ := json.Marshal(map[string]any{
		"id": "response", "object": "chat.completion.chunk", "created": 1, "model": "local",
		"choices": []map[string]any{{"index": 0, "delta": delta, "finish_reason": nil}},
	})
	_, _ = fmt.Fprintf(writer, "data: %s\n\n", first)
	last, _ := json.Marshal(map[string]any{
		"id":      "response",
		"choices": []map[string]any{{"index": 0, "delta": map[string]any{}, "finish_reason": finishReason}},
		"usage":   map[string]any{"prompt_tokens": 40, "completion_tokens": 10},
	})
	_, _ = fmt.Fprintf(writer, "data: %s\n\n", last)
	_, _ = io.WriteString(writer, "data: [DONE]\n\n")
}

func (p *Provider) caseFor() Case {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.script
}

func (p *Provider) Script(caseScript Case) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.script = caseScript
}

func (p *Provider) LastWords() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	for index := len(p.answers) - 1; index >= 0; index-- {
		if strings.TrimSpace(p.answers[index]) != "" {
			return strings.TrimSpace(p.answers[index])
		}
	}
	return ""
}

func (p *Provider) Requests() int {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.requests
}

func (p *Provider) Close() {
	p.server.Close()
}
