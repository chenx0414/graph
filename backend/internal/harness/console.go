package harness

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

type Console struct {
	URL    string
	origin string
	cookie string
	client *http.Client
}

func OpenConsole(url string) (*Console, error) {
	client := &http.Client{Timeout: 30 * time.Second}
	response, err := client.Get(url + "/")
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	_, _ = io.Copy(io.Discard, response.Body)
	cookies := response.Cookies()
	console := &Console{URL: url, origin: url, client: client}
	for _, cookie := range cookies {
		console.cookie = cookie.Name + "=" + cookie.Value
	}
	if console.cookie == "" {
		return nil, fmt.Errorf("the console handed out no session cookie")
	}
	return console, nil
}

type Response struct {
	Status int
	Body   any
	Text   string
}

func (c *Console) Request(method, path string, body any) (Response, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return Response{}, err
		}
		reader = strings.NewReader(string(payload))
	}
	request, err := http.NewRequest(method, c.URL+path, reader)
	if err != nil {
		return Response{}, err
	}
	request.Header.Set("origin", c.origin)
	request.Header.Set("cookie", c.cookie)
	request.Header.Set("content-type", "application/json")
	response, err := c.client.Do(request)
	if err != nil {
		return Response{}, err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	if err != nil {
		return Response{}, err
	}
	answer := Response{Status: response.StatusCode, Text: string(payload)}
	if len(payload) > 0 {
		var parsed any
		if json.Unmarshal(payload, &parsed) == nil {
			answer.Body = parsed
		} else {
			answer.Body = answer.Text
		}
	}
	return answer, nil
}

func (c *Console) JSON(path string, out any) error {
	response, err := c.Request("GET", path, nil)
	if err != nil {
		return err
	}
	if response.Status < 200 || response.Status >= 300 {
		return fmt.Errorf("GET %s -> %d: %s", path, response.Status, truncate(response.Text, 400))
	}
	if out == nil {
		return nil
	}
	payload, err := json.Marshal(response.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, out)
}

func (c *Console) Post(path string, body, out any) error {
	response, err := c.Request("POST", path, body)
	if err != nil {
		return err
	}
	if response.Status < 200 || response.Status >= 300 {
		return fmt.Errorf("POST %s -> %d: %s", path, response.Status, truncate(response.Text, 400))
	}
	if out == nil {
		return nil
	}
	payload, err := json.Marshal(response.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(payload, out)
}

func truncate(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}

type operation struct {
	ID           string `json:"id"`
	State        string `json:"state"`
	WorkerActive bool   `json:"workerActive"`
}

type createdConversation struct {
	ConversationID string `json:"conversationId"`
	TaskID         string `json:"taskId"`
}
