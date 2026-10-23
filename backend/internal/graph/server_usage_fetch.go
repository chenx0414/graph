package graph

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"time"
)

// usageFetch performs one bounded HTTP request and reads the whole body.
func usageFetch(method, url string, headers map[string]string, body []byte, timeoutMs int) (int, http.Header, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(timeoutMs)*time.Millisecond)
	defer cancel()
	var reader io.Reader
	if body != nil {
		reader = bytes.NewReader(body)
	}
	request, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return 0, nil, nil, err
	}
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	response, err := HTTPClient.Do(request)
	if err != nil {
		return 0, nil, nil, err
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(response.Body)
	if err != nil {
		return response.StatusCode, response.Header, nil, err
	}
	return response.StatusCode, response.Header, raw, nil
}

// usageResponseJSON reads a JSON object reply.
func usageResponseJSON(status int, raw []byte, label string) (map[string]any, error) {
	if status < 200 || status >= 300 {
		return nil, fmt.Errorf("%s HTTP %d", label, status)
	}
	var parsed any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, fmt.Errorf("%s 响应解析失败", label)
	}
	body := usageRecord(parsed)
	if body == nil {
		return nil, errors.New("响应不是 JSON 对象")
	}
	return body, nil
}

// usageWindowDetails are the optional numbers a quota window carries.
type usageWindowDetails struct {
	Used  *float64
	Limit *float64
	Unit  *string
}
