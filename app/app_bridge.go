package main

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"time"
)

func (c apiClient) postApp(path string, appToken string, body any) ([]byte, error) {
	encoded := []byte("{}")
	if body != nil {
		var err error
		if encoded, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	request, err := http.NewRequest(http.MethodPost, c.address+path, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	c.authorize(request)
	request.Header.Set("Origin", c.address)
	request.Header.Set("content-type", "application/json")
	request.Header.Set("x-graph-app-token", strings.TrimSpace(appToken))
	response, err := (&http.Client{Timeout: 60 * time.Second}).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return payload, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return payload, errStatus(response.Status)
	}
	return payload, nil
}
