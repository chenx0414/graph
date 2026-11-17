package appinstance

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

type API struct {
	Base   string
	Token  string
	Client *http.Client
}

func (i *Instance) API() *API {
	token := ""
	if payload, err := os.ReadFile(i.TokenPath()); err == nil {
		token = strings.TrimSpace(string(payload))
	}
	return &API{
		Base:   strings.TrimSuffix(i.URL, "/"),
		Token:  token,
		Client: &http.Client{Timeout: 20 * time.Second},
	}
}

type Reply struct {
	Status int             `json:"status"`
	Body   json.RawMessage `json:"body,omitempty"`
	Text   string          `json:"text,omitempty"`
	Path   string          `json:"path"`
	Method string          `json:"method"`
}

func (a *API) Healthy() bool {
	if a.Base == "" {
		return false
	}
	reply, err := a.Do("GET", "/api/health", nil)
	return err == nil && reply.Status == 200
}

func (a *API) Do(method, path string, body any) (Reply, error) {
	if a.Base == "" {
		return Reply{}, fmt.Errorf("no console url yet; launch the instance first")
	}
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return Reply{}, err
		}
		reader = bytes.NewReader(payload)
	}
	request, err := http.NewRequest(method, a.Base+path, reader)
	if err != nil {
		return Reply{}, err
	}
	request.Header.Set("Origin", a.Base)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if a.Token != "" {
		request.AddCookie(&http.Cookie{Name: "graph_session", Value: a.Token})
	}
	response, err := a.Client.Do(request)
	if err != nil {
		return Reply{}, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return Reply{}, err
	}
	reply := Reply{Status: response.StatusCode, Path: path, Method: method}
	if json.Valid(payload) {
		reply.Body = json.RawMessage(payload)
	} else {
		reply.Text = truncate(string(payload), 4000)
	}
	return reply, nil
}

type Check struct {
	ID       string   `json:"id"`
	OK       bool     `json:"ok"`
	Expected string   `json:"expected,omitempty"`
	Actual   string   `json:"actual,omitempty"`
	Evidence []string `json:"evidence,omitempty"`
	Hint     string   `json:"hint,omitempty"`
}

func (r Reply) Assert(id string, status int, keys ...string) Check {
	check := Check{ID: id, Expected: fmt.Sprintf("HTTP %d", status), Actual: fmt.Sprintf("HTTP %d", r.Status)}
	if r.Status != status {
		check.Hint = fmt.Sprintf("GET %s returned %d: %s", r.Path, r.Status, summarizeBody(r))
		return check
	}
	for _, key := range keys {
		var document map[string]any
		if err := json.Unmarshal(r.Body, &document); err != nil {
			check.Actual = "body is not a JSON object: " + summarizeBody(r)
			check.Hint = "GET " + r.Path + " should answer JSON"
			return check
		}
		if _, ok := document[key]; !ok {
			check.Actual = "JSON object without key " + key
			check.Hint = "GET " + r.Path + " should carry " + key
			return check
		}
	}
	check.OK = true
	check.Actual = fmt.Sprintf("HTTP %d, keys %v present", r.Status, keys)
	return check
}

func summarizeBody(reply Reply) string {
	if len(reply.Body) > 0 {
		return truncate(string(reply.Body), 300)
	}
	return truncate(reply.Text, 300)
}

func truncate(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit] + "…(truncated)"
}

func Redact(value string) string {
	if len(value) < 8 {
		return "<redacted>"
	}
	sum := sha256.Sum256([]byte(value))
	return "<redacted:sha256:" + hex.EncodeToString(sum[:6]) + ">"
}
