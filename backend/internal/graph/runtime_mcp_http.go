package graph

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"bytes"
)

type HttpEndpoint struct {
	Gate      RestrictedGate
	Url       string
	Headers   map[string]string
	TimeoutMs *int
}

func HttpExchange(endpoint HttpEndpoint) McpExchange {
	return httpMcp{endpoint: endpoint}
}

type httpMcp struct{ endpoint HttpEndpoint }

func (exchange httpMcp) Exchange(requests []any, expect int) McpReply {
	timeout := 30000
	if exchange.endpoint.TimeoutMs != nil {
		timeout = *exchange.endpoint.TimeoutMs
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeout)*time.Millisecond)
	defer cancel()
	session := map[string]string{}
	var reply *McpReply
	for _, request := range requests {
		response := gatedRequest(exchange.endpoint.Gate, func() any {
			return mcpPost(ctx, exchange.endpoint, session, request)
		}).(*http.Response)
		if id := response.Header.Get("mcp-session-id"); id != "" {
			session["mcp-session-id"] = id
		}
		if response.StatusCode == 202 || response.StatusCode == 204 {
			_, _ = io.Copy(io.Discard, response.Body)
			response.Body.Close()
			continue
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			response.Body.Close()
			Raise("capability_failed", "Remote MCP answered HTTP "+itoa(response.StatusCode))
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, 2_000_001))
		response.Body.Close()
		if err != nil {
			panic(err)
		}
		if len(body) > 2_000_000 {
			Raise("capability_failed", "Remote MCP response exceeded the size bound")
		}
		if strings.TrimSpace(string(body)) == "" {
			continue
		}
		for _, message := range parseHttpBody(string(body), response.Header.Get("content-type")) {
			if mcpIdEqual(message.Id, expect) {
				copy := message
				reply = &copy
			}
		}
	}
	if reply == nil {
		Raise("capability_failed", "Remote MCP did not answer request "+itoa(expect))
	}
	if reply.Error != nil {
		message := "Remote MCP error"
		if reply.Error.Message != nil {
			message = *reply.Error.Message
		}
		Raise("capability_failed", message)
	}
	if _, ok := reply.raw["result"]; !ok {
		Raise("capability_failed", "Remote MCP returned no result for request "+itoa(expect))
	}
	return *reply
}

func mcpPost(ctx context.Context, endpoint HttpEndpoint, session map[string]string, request any) *http.Response {
	encoded, err := json.Marshal(request)
	if err != nil {
		panic(err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.Url, bytes.NewReader(encoded))
	if err != nil {
		panic(err)
	}
	req.Header.Set("content-type", "application/json")
	req.Header.Set("accept", "application/json, text/event-stream")
	for key, value := range endpoint.Headers {
		req.Header.Set(key, value)
	}
	for key, value := range session {
		req.Header.Set(key, value)
	}
	client := &http.Client{
		Timeout:   0,
		Transport: HTTPClient.Transport,
		CheckRedirect: func(*http.Request, []*http.Request) error {
			return errors.New("redirects are not allowed")
		},
	}
	response, err := client.Do(req)
	if err != nil {
		panic(err)
	}
	return response
}

func parseHttpBody(body, contentType string) []McpReply {
	if strings.Contains(contentType, "text/event-stream") {
		replies := []McpReply{}
		for _, line := range strings.Split(body, "\n") {
			if !strings.HasPrefix(line, "data:") {
				continue
			}
			data := strings.TrimSpace(line[5:])
			if data == "" || data == "[DONE]" {
				continue
			}
			if message, ok := mcpParseReply(data); ok {
				replies = append(replies, message)
			}
		}
		return replies
	}
	trimmed := strings.TrimSpace(body)
	if strings.HasPrefix(trimmed, "[") {
		var list []map[string]any
		if err := json.Unmarshal([]byte(body), &list); err != nil {
			panic(err)
		}
		out := make([]McpReply, 0, len(list))
		for _, item := range list {
			out = append(out, mcpReplyFromMap(item))
		}
		return out
	}
	message, ok := mcpParseReply(body)
	if !ok {
		panic(errors.New("Remote MCP response was not JSON"))
	}
	return []McpReply{message}
}

func requireMcpResult(reply McpReply, expect int) McpReply {
	if reply.Error != nil {
		message := "MCP server error"
		if reply.Error.Message != nil {
			message = *reply.Error.Message
		}
		Raise("capability_failed", message)
	}
	if _, ok := reply.raw["result"]; !ok {
		Raise("capability_failed", "MCP server returned no result for request "+itoa(expect))
	}
	return reply
}
