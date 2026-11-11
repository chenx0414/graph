package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type errStatus string

func (e errStatus) Error() string { return "服务端拒绝：" + string(e) }

type apiClient struct {
	address string
	token   string
}

func newAPIClient(address, token string) apiClient {
	return apiClient{address: strings.TrimSuffix(address, "/"), token: strings.TrimSpace(token)}
}

func (c apiClient) get(path string) ([]byte, error) {
	request, err := http.NewRequest(http.MethodGet, c.address+path, nil)
	if err != nil {
		return nil, err
	}
	c.authorize(request)
	response, err := (&http.Client{Timeout: 10 * time.Second}).Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return payload, err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return payload, fmt.Errorf("%s 返回 %d", path, response.StatusCode)
	}
	return payload, nil
}

func (c apiClient) post(path string, body any) ([]byte, error) {
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

func (c apiClient) authorize(request *http.Request) {
	if c.token != "" {
		request.Header.Set("Cookie", "graph_session="+c.token)
	}
}
