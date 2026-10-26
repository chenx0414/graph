package graph

import (
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"time"

	"context"
)

// RetrievalResult is one granted textual fetch.
type RetrievalResult struct {
	Url         string `json:"url"`
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
	Text        string `json:"text"`
	Truncated   bool   `json:"truncated"`
}

var retrievalTextual = regexp.MustCompile(`^(text/|application/(json|xml|xhtml\+xml)|.*\+json)`)

func retrievalCheckedURL(value string, domains []string, unrestricted bool) string {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		Raise("retrieval_denied", "Not a valid URL: "+value)
	}
	if parsed.Scheme != "https" && parsed.Scheme != "http" {
		Raise("retrieval_denied", "Only http and https retrieval is allowed: "+parsed.Scheme+":")
	}
	if parsed.User != nil {
		name := parsed.User.Username()
		password, hasPassword := parsed.User.Password()
		if name != "" || hasPassword && password != "" || parsed.User.String() != "" {
			Raise("retrieval_denied", "URLs with embedded credentials are not allowed")
		}
	}
	if !unrestricted && !AllowedDomain(domains, parsed.Hostname()) {
		Raise("retrieval_denied", "Host "+parsed.Hostname()+" is not in the granted retrieval domains")
	}
	return parsed.String()
}

func retrievalReadBody(body io.ReadCloser, maxBytes int) (string, bool) {
	if body == nil {
		return "", false
	}
	defer body.Close()
	buf := make([]byte, 0, 4096)
	chunk := make([]byte, 32*1024)
	truncated := false
	for {
		n, err := body.Read(chunk)
		if n > 0 {
			room := maxBytes - len(buf)
			if room < 0 {
				room = 0
			}
			if n > room {
				if room > 0 {
					buf = append(buf, chunk[:room]...)
				}
				truncated = true
				break
			}
			buf = append(buf, chunk[:n]...)
		}
		if err != nil {
			break
		}
	}
	return string(buf), truncated
}

// RetrievalBroker is the controlled read broker for granted domains.
type RetrievalBroker struct {
	Domains      []string
	gate         SendGate
	unrestricted bool
	timeoutMs    int
	maxBytes     int
}

// CreateRetrievalBroker validates protocol, credentials and the domain allowlist before one gated request.
func CreateRetrievalBroker(domains []string, gate SendGate, unrestricted bool, timeoutMs, maxBytes int) *RetrievalBroker {
	if timeoutMs <= 0 {
		timeoutMs = 20000
	}
	if maxBytes <= 0 {
		maxBytes = 1_000_000
	}
	return &RetrievalBroker{
		Domains: NormalizeDomains(domains), gate: gate, unrestricted: unrestricted, timeoutMs: timeoutMs, maxBytes: maxBytes,
	}
}

// Fetch performs one gated retrieval. Redirects are refused.
func (broker *RetrievalBroker) Fetch(urlText string, signal *AbortSignal) (result RetrievalResult) {
	target := retrievalCheckedURL(urlText, broker.Domains, broker.unrestricted)
	invocationID := graphUUID()
	var failure *RuntimeError
	broker.gate.Dispatch(invocationID, 0, func() any {
		defer broker.gate.Settle(invocationID, &TokenUsage{})
		ctx, cancel := context.WithTimeout(context.Background(), time.Duration(broker.timeoutMs)*time.Millisecond)
		defer cancel()
		if signal != nil {
			if signal.Aborted() {
				cancel()
			} else {
				signal.AddEventListener("abort", func() { cancel() }, true)
			}
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
		if err != nil {
			failure = &RuntimeError{Code: "retrieval_failed", Message: "Retrieval failed: " + err.Error()}
			return nil
		}
		request.Header.Set("accept", "text/*, application/json;q=0.9, application/xml;q=0.8")
		client := *HTTPClient
		client.CheckRedirect = func(*http.Request, []*http.Request) error {
			return fmt.Errorf("redirect refused")
		}
		response, err := client.Do(request)
		if err != nil {
			failure = &RuntimeError{Code: "retrieval_failed", Message: "Retrieval failed: " + err.Error()}
			return nil
		}
		defer response.Body.Close()
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			failure = &RuntimeError{Code: "retrieval_failed", Message: fmt.Sprintf("Retrieval answered HTTP %d", response.StatusCode)}
			return nil
		}
		contentType := response.Header.Get("content-type")
		media := contentType
		if semi := indexByte(media, ';'); semi >= 0 {
			media = media[:semi]
		}
		if !retrievalTextual.MatchString(media) && !retrievalTextual.MatchString(contentType) {
			shown := contentType
			if shown == "" {
				shown = "unknown"
			}
			failure = &RuntimeError{Code: "retrieval_failed", Message: "Refusing non-textual content type " + shown}
			return nil
		}
		text, truncated := retrievalReadBody(response.Body, broker.maxBytes)
		result = RetrievalResult{Url: target, Status: response.StatusCode, ContentType: contentType, Text: text, Truncated: truncated}
		return nil
	})
	if failure != nil {
		panic(failure)
	}
	return result
}

func indexByte(value string, needle byte) int {
	for i := 0; i < len(value); i++ {
		if value[i] == needle {
			return i
		}
	}
	return -1
}
