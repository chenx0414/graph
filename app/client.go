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

const apiTimeout = 30 * time.Second

type errStatus string

func (e errStatus) Error() string { return "服务端拒绝：" + string(e) }

func rejectionMessage(payload []byte) string {
	var body struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(payload, &body) != nil {
		return ""
	}
	return strings.TrimSpace(body.Message)
}

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
	response, err := (&http.Client{Timeout: apiTimeout}).Do(request)
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
		detail := response.Status
		if message := rejectionMessage(payload); message != "" {
			detail += " · " + message
		}
		return payload, errStatus(detail)
	}
	return payload, nil
}

func (c apiClient) delete(path string) ([]byte, error) {
	request, err := http.NewRequest(http.MethodDelete, c.address+path, nil)
	if err != nil {
		return nil, err
	}
	c.authorize(request)
	request.Header.Set("Origin", c.address)
	response, err := (&http.Client{Timeout: apiTimeout}).Do(request)
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
