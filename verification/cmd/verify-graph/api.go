package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type apiClient struct {
	base  string
	token string
}

func newAPIClient(base, token string) *apiClient {
	return &apiClient{base: strings.TrimSuffix(base, "/"), token: token}
}

func (c *apiClient) do(method, path string, body any) (int, []byte, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return 0, nil, err
		}
		reader = bytes.NewReader(raw)
	}
	request, err := http.NewRequest(method, c.base+path, reader)
	if err != nil {
		return 0, nil, err
	}
	request.Header.Set("Cookie", "graph_session="+c.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if method != http.MethodGet && method != http.MethodHead {
		parsed, err := url.Parse(c.base)
		if err != nil {
			return 0, nil, err
		}
		request.Header.Set("Origin", "http://"+parsed.Host)
	}
	client := &http.Client{Timeout: 20 * time.Second}
	response, err := client.Do(request)
	if err != nil {
		return 0, nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(io.LimitReader(response.Body, 8<<20))
	if err != nil {
		return response.StatusCode, nil, err
	}
	return response.StatusCode, payload, nil
}

func (c *apiClient) getJSON(path string, target any) (int, error) {
	status, payload, err := c.do(http.MethodGet, path, nil)
	if err != nil {
		return status, err
	}
	if target != nil && status == http.StatusOK {
		if err := json.Unmarshal(payload, target); err != nil {
			return status, fmt.Errorf("%s answered with invalid JSON: %w", path, err)
		}
	}
	return status, nil
}

func readConsole(stateDir string) (consoleFile, bool) {
	raw, err := os.ReadFile(filepath.Join(stateDir, "console.json"))
	if err != nil {
		return consoleFile{}, false
	}
	var value consoleFile
	if err := json.Unmarshal(raw, &value); err != nil || value.URL == "" || value.PID == 0 {
		return consoleFile{}, false
	}
	return value, true
}

func readToken(stateDir string) string {
	raw, err := os.ReadFile(filepath.Join(stateDir, "session-token"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(raw))
}

type consoleFile struct {
	URL       string `json:"url"`
	PID       int    `json:"pid"`
	Mode      string `json:"mode"`
	StartedAt int64  `json:"startedAt"`
}
